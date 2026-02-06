import type { Job } from 'bullmq';
import type { Logger, RunJob, ToolCall, ToolResult, ToolDef } from '@clifford/sdk';
import { parseToolCommandName } from '@clifford/sdk';
import {
  getDb,
  runs,
  runSteps,
  agentPlugins,
  userSettings,
  channels,
  messages,
  memoryItems,
  userToolSettings,
  triggers,
} from '@clifford/db';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { PolicyEngine } from '@clifford/policy';
import { ToolRegistry } from './tool-registry.js';
import { nanoid } from 'nanoid';
import { config } from './config.js';
import { decryptSecret } from './crypto.js';
import { callOpenAIWithFallback, type OpenAIMessage } from './openai-client.js';
import { ZodError } from 'zod';
import { enqueueDelivery, enqueueRun, enqueueRunWake } from './queues.js';
import { randomUUID } from 'crypto';

type RunCommand =
  | {
      type: 'tool_call';
      name: string;
      args?: Record<string, unknown>;
    }
  | {
      type: 'send_message';
      message: string;
    }
  | {
      type: 'deliver_subagent_output';
      runId: string;
    }
  | {
      type: 'request_parent';
      message: string;
    }
  | {
      type: 'reply_subagent';
      runId: string;
      message: string;
    }
  | {
      type: 'retry_subagent';
      runId: string;
      feedback?: string;
    }
  | {
      type: 'queue_op';
      action: 'push' | 'shift' | 'clear' | 'set';
      items?: string[];
    }
  | {
      type: 'set_output';
      output: string;
      mode?: 'replace' | 'append';
    }
  | {
      type: 'finish';
      output?: string;
      mode?: 'replace' | 'append';
    }
  | {
      type: 'decision';
      content: string;
      importance?: 'low' | 'normal' | 'high';
    }
  | {
      type: 'note';
      category: 'requirements' | 'plan' | 'artifact' | 'validation';
      content: string;
    }
  | {
      type: 'set_run_limits';
      maxIterations: number;
      reason?: string;
    };
type SubagentSpec = {
  id?: string;
  profile?: string;
  task: string;
  agentLevel?: number;
  tools?: string[];
  context?: Array<{ role: 'user' | 'assistant'; content: string }>;
};

type SpawnCommand =
  | {
      type: 'spawn_subagent';
      subagent: SubagentSpec;
    }
  | {
      type: 'spawn_subagents';
      subagents: SubagentSpec[];
    }
  | {
      type: 'sleep';
      reason?: string;
      wakeAt?: string;
      delaySeconds?: number;
      cron?: string;
    };

type TranscriptEntry =
  | { type: 'assistant_message'; content: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; result: unknown }
  | { type: 'output_update'; output: string; mode: 'replace' | 'append' }
  | { type: 'decision'; content: string; importance?: 'low' | 'normal' | 'high' }
  | { type: 'note'; category: 'requirements' | 'plan' | 'artifact' | 'validation'; content: string }
  | { type: 'system_note'; content: string }
  | { type: 'validation_missing'; detail: string };

type RunState = {
  queue: string[];
  inbox: Array<{ fromRunId: string; message: string; at: string }>;
  waitingForParent?: boolean;
  autoRecoverySpawned?: boolean;
  lastRequestParentMessage?: string;
  requestParentRepeatCount?: number;
  lastBlockReason?: string;
  lastBlockDetail?: string;
};

export async function processRun(job: Job<RunJob>, logger: Logger) {
  const { runId, tenantId, agentId } = job.data;
  const db = getDb();

  logger.info('Processing run', { runId });

  // 1. Load run
  const runData = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (runData.length === 0) {
    throw new Error(`Run not found: ${runId}`);
  }
  const run = runData[0];

  if (!run) {
    throw new Error(`Run data is null: ${runId}`);
  }

  if (!run.userId || !run.channelId) {
    throw new Error('Run missing userId/channelId; cannot deliver messages');
  }

  // Update status to running (only if not already running by another worker)
  const updated = await db
    .update(runs)
    .set({ status: 'running', updatedAt: new Date() })
    .where(and(eq(runs.id, runId), eq(runs.status, 'pending')))
    .returning({ id: runs.id });
  if (!updated || updated.length === 0) {
    logger.warn('Run already claimed by another worker', { runId, status: run.status });
    return;
  }

  let stepSeq = 0;
  let lastToolError: { tool: string; error?: string } | null = null;
    const repeatedCallCounts = new Map<string, number>();
    const repeatedResultCounts = new Map<string, number>();
  const repeatedSpawnCounts = new Map<string, number>();
    let blockedSpawnCount = 0;
    let lastSpawnSignature: string | null = null;

  try {
    // 2. Load agent plugins
    const plugins = await db
      .select()
      .from(agentPlugins)
      .where(eq(agentPlugins.agentId, agentId));

    const enabledPluginNames = plugins
      .filter((plugin) => plugin.enabled)
      .map((plugin) => plugin.pluginName);

    // 3. Register tools
    const toolRegistry = new ToolRegistry(logger);
    if (plugins.length === 0) {
      await toolRegistry.loadAllPlugins();
    } else if (enabledPluginNames.length > 0) {
      await toolRegistry.loadPlugins(enabledPluginNames);
    }

    const toolSettings = await db
      .select()
      .from(userToolSettings)
      .where(eq(userToolSettings.userId, run.userId));
    const toolSettingsMap = new Map(toolSettings.map((row) => [row.toolName, row]));
    const hasUserToolSettings = toolSettings.length > 0;
    const toolConfigMap = new Map<string, Record<string, unknown>>();

    const enabledTools = toolRegistry.getAllTools().filter((tool) => {
      const setting = toolSettingsMap.get(tool.name);
      return setting?.enabled ?? true;
    });

    const allowedToolSet =
      Array.isArray(run.allowedTools) && run.allowedTools.length > 0
        ? new Set((run.allowedTools as string[]).map((item) => item.trim()))
        : null;

    const filteredTools = allowedToolSet
      ? enabledTools.filter((tool) => allowedToolSet.has(tool.name) || tool.name === 'tools')
      : enabledTools;

    const patchedTools = filteredTools.map((tool) => {
      const setting = toolSettingsMap.get(tool.name);
      if (setting?.config && tool.config?.schema) {
        const parsed = tool.config.schema.safeParse(setting.config);
        if (parsed.success) {
          toolConfigMap.set(tool.name, parsed.data as Record<string, unknown>);
        } else {
          logger.warn({ tool: tool.name, issues: parsed.error.issues }, 'Invalid tool config');
          toolConfigMap.set(tool.name, {});
        }
      } else {
        toolConfigMap.set(tool.name, (setting?.config as Record<string, unknown>) ?? {});
      }

      return {
        ...tool,
        pinned: setting?.pinned ?? (hasUserToolSettings ? false : tool.pinned ?? false),
        important: setting?.important ?? (hasUserToolSettings ? false : tool.important ?? false),
      };
    });

    toolRegistry.setTools(patchedTools);

    // 4. Initialize policy engine
    const policyEngine = new PolicyEngine();

    // 5. Load user LLM settings
    const [settings] = await db
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, run.userId))
      .limit(1);

    if (!settings || !settings.llmApiKeyEncrypted) {
      throw new Error('Missing LLM API key for run');
    }

    if (!settings.llmApiKeyIv || !settings.llmApiKeyTag) {
      throw new Error('LLM API key missing encryption metadata');
    }

    if (!config.encryptionKey) {
      throw new Error('DATA_ENCRYPTION_KEY not configured for worker');
    }

    const apiKey = decryptSecret(
      settings.llmApiKeyEncrypted,
      settings.llmApiKeyIv,
      settings.llmApiKeyTag,
      config.encryptionKey
    ).trim();

    if (!apiKey.startsWith('sk-')) {
      throw new Error('OpenAI API key appears invalid (must start with "sk-")');
    }

    const provider = settings.llmProvider || 'openai';
    const model = settings.llmModel || 'gpt-4o-mini';
    const fallbackModel = settings.llmFallbackModel || null;

    if (provider !== 'openai') {
      throw new Error(`Unsupported LLM provider: ${provider}`);
    }

    const toolDescriptions = buildToolPrompt(toolRegistry.getAllTools(), run.kind ?? 'coordinator');
    const agentLevelForPrompt =
      run.kind === 'subagent' ? ((run.inputJson as any)?.agentLevel ?? 1) : 0;
    const isCoordinator = run.kind !== 'subagent';
    const isSubagent = run.kind === 'subagent' && agentLevelForPrompt === 1;
    const isSubsubagent = run.kind === 'subagent' && agentLevelForPrompt >= 2;
    const rolePrompt = isCoordinator
      ? 'ROLE: Coordinator (Project Manager)\n' +
        '- You do NOT do the real work. You do NOT call tools. You do NOT produce the final output.\n' +
        '- Your job is to decompose the task, define scopes, and delegate to subagents.\n' +
        '- Use queue_op to manage tasks. Use spawn_subagent(s) to assign work with precise context and success criteria.\n' +
        '- When a subagent finishes, review and either deliver_subagent_output or retry_subagent with feedback.\n' +
        '- Never emit request_parent. If you need more info from subagents, reply_subagent or spawn new ones.\n'
      : isSubagent
        ? 'ROLE: Subagent (Worker)\n' +
          '- You DO the real work. Use tools as needed, including tools.list/tools.describe to find the right tool.\n' +
          '- You must finish with a concrete output for the coordinator (not the user).\n' +
          '- If blocked, use request_parent exactly once with a clear, specific question.\n' +
          '- You may delegate only if the coordinator explicitly allowed it in your inputJson (allowSubagents=true) AND agentLevel<2. Otherwise do not spawn.\n'
        : 'ROLE: Subsubagent (Executor)\n' +
          '- You DO the real work and must not delegate.\n' +
          '- Use tools as needed and finish with a concrete output for the coordinator.\n';

    const examplePrompt = isCoordinator
      ? 'EXAMPLES (Coordinator):\n' +
        '1) Build queue\n' +
        '{"type":"queue_op","action":"set","items":["Fetch February weather for Bremen","Summarize best riding day"]}\n' +
        '2) Spawn subagents with context\n' +
        '{"type":"spawn_subagents","subagents":[{"profile":"research","task":"Fetch February weather for Bremen","tools":["weather.get"],"context":[{"role":"user","content":"User request summary: Find best February riding day for motorcycle TÜV in Bremen. Location/time window: Bremen, Germany · 2026-02-01 to 2026-02-28. Tools to use: weather.get. Expected output format: bullet list of top 3 days with conditions and a single best day. Success criteria: pick safest day (low precip, mild temp, low wind)."}],"agentLevel":1}]}\n' +
        '3) Deliver output\n' +
        '{"type":"deliver_subagent_output","runId":"<subagent-run-id>"}\n'
      : isSubagent
        ? 'EXAMPLES (Subagent):\n' +
          '1) Use tool\n' +
          '{"type":"tool_call","name":"weather.get","args":{"location":"Bremen, Germany","startDate":"2026-02-01","endDate":"2026-02-28"}}\n' +
          '2) Finish with output for coordinator\n' +
          '{"type":"finish","output":"Best day: 2026-02-12 (dry, mild, low wind). Runner-ups: 2026-02-10, 2026-02-14."}\n' +
          '3) Ask parent if blocked\n' +
          '{"type":"request_parent","message":"Weather tool unavailable. Which alternative tool should I use?"}\n'
        : 'EXAMPLES (Subsubagent):\n' +
          '{"type":"tool_call","name":"weather.get","args":{"location":"Bremen, Germany","startDate":"2026-02-01","endDate":"2026-02-28"}}\n' +
          '{"type":"finish","output":"Best day: 2026-02-12 (dry, mild, low wind)."}\n';

    const systemPrompt =
      'You are a task agent. You MUST respond with a single JSON object only. ' +
      'No prose, no markdown. The JSON must match one of these shapes:\n' +
      '1) {"type":"tool_call","name":"tool.command","args":{...}}\n' +
      '2) {"type":"send_message","message":"..."}\n' +
      '3) {"type":"deliver_subagent_output","runId":"..."}\n' +
      '4) {"type":"request_parent","message":"..."}\n' +
      '5) {"type":"reply_subagent","runId":"...","message":"..."}\n' +
      '6) {"type":"retry_subagent","runId":"...","feedback":"..."}\n' +
      '7) {"type":"queue_op","action":"push"|"shift"|"clear"|"set","items":["..."]}\n' +
      '8) {"type":"set_output","output":"...","mode":"replace"|"append"}\n' +
      '9) {"type":"finish","output":"...","mode":"replace"|"append"}\n' +
      '10) {"type":"decision","content":"...","importance":"low"|"normal"|"high"}\n' +
      '11) {"type":"note","category":"requirements"|"plan"|"artifact"|"validation","content":"..."}\n' +
      '12) {"type":"set_run_limits","maxIterations":12,"reason":"..."}\n' +
      '13) {"type":"spawn_subagent","subagent":{"profile":"...","task":"...","tools":["..."],"context":[...],"agentLevel":1}}\n' +
      '14) {"type":"spawn_subagents","subagents":[{"profile":"...","task":"...","tools":["..."],"context":[...],"agentLevel":1}]}\n' +
      '15) {"type":"sleep","reason":"...","wakeAt":"ISO-8601","delaySeconds":123,"cron":"*/5 * * * *"}\n' +
      'INTERNAL COMMANDS (not tools): tool_call, send_message, deliver_subagent_output, request_parent, reply_subagent, retry_subagent, queue_op, set_output, finish, decision, note, set_run_limits, spawn_subagent(s), sleep.\n' +
      'ROLE SCOPES:\n' +
      '- Coordinator: queue_op, spawn_subagent(s), reply_subagent, retry_subagent, deliver_subagent_output, send_message, set_run_limits, decision, note, sleep, finish.\n' +
      '- Subagent: tool_call, request_parent, finish, set_output, decision, note, set_run_limits, sleep (only when waitingForParent=true).\n' +
      '- Subsubagent: tool_call, finish, set_output, decision, note, set_run_limits, sleep (only when waitingForParent=true). No spawning.\n' +
      'COMMAND USAGE EXAMPLES:\n' +
      '- tool_call: {"type":"tool_call","name":"tools.list","args":{}}\n' +
      '- send_message: {"type":"send_message","message":"Working on it; waiting for subagent results."}\n' +
      '- request_parent: {"type":"request_parent","message":"Weather tool missing. Which tool should I use?"}\n' +
      '- reply_subagent: {"type":"reply_subagent","runId":"<sub-run-id>","message":"Use tools.list then weather.get."}\n' +
      '- deliver_subagent_output: {"type":"deliver_subagent_output","runId":"<sub-run-id>"}\n' +
      '- set_output: {"type":"set_output","output":"Draft answer...","mode":"append"}\n' +
      '- spawn_subagent: {"type":"spawn_subagent","subagent":{"profile":"research","task":"Fetch February weather for Bremen","tools":["weather.get"],"context":[{"role":"user","content":"Location: Bremen, Germany. Dates: 2026-02-01 to 2026-02-28. Output: best day + top 3 days."}],"agentLevel":1}}\n' +
      '- sleep: {"type":"sleep","delaySeconds":30,"reason":"Waiting for subagent output"}\n' +
      '- queue_op: {"type":"queue_op","action":"set","items":["Task A","Task B"]}\n' +
      '- finish: {"type":"finish","output":"<final output for coordinator or user>","mode":"replace"}\n' +
      'DEFAULT: answer directly and finish in a single step when possible. ' +
      'Only use tool_call if it is necessary to answer correctly. ' +
      'Avoid multi-step iteration for simple questions. ' +
      'Preserve line breaks in message/output using \\n. ' +
      'If you are unsure how to answer or need capabilities, first call tools.list. ' +
      'If tools.list suggests a relevant tool, call tools.describe for that tool before replying. ' +
      'Do NOT respond with "I cannot" or "I do not have access" without checking tools first. ' +
      'Tool calls must use the full command name (tool.command), not just the tool name. ' +
      'Use send_message only to provide progress updates for long tasks. ' +
      'Use set_output when assembling a longer response over multiple steps (subagents/subsubagents only). ' +
      'Use finish when the task is complete; coordinators may finish only after validating that output meets the requirements they set. ' +
      'Use decision to record brief coordinator reasoning/justifications; it is shown in the coordinator view but not sent to the user. ' +
      'Use note to record requirements, plan, artifacts, and validation summaries; it is shown in the task view. ' +
      'Requirements note must specify the expected output and decision criteria, not restate the task. ' +
      'Plan note must be concrete and stepwise (numbered steps), naming the tools you will call and any key parameters (e.g., date ranges). ' +
      'Artifact note must be exactly one sentence describing the immediate next step you are about to take (not repeating requirements/plan). ' +
      'Before taking any action (tool_call, send_message, set_output, finish, spawn, sleep), emit note(category="artifact") with exactly one sentence explaining why you are doing the next step and what you are thinking about. After that rationale note, your next response MUST be an action, not another note. ' +
      'If you emit a plan note in a coordinator run, you MUST set_run_limits next. Choose a maxIterations high enough to complete the plan; use the minimum only for very simple tasks. ' +
      'If required data is missing or a tool returns success:false, you MUST finish with a limitation statement and best-effort output. Do not keep iterating. ' +
      'Never claim a multi-day forecast unless the tool result includes daily[]. ' +
      'If a tool has a days/limit constraint (e.g., max 14 days), split the request into multiple calls using startDate to cover the full range. ' +
      'When unsure or planning multi-step work, emit a decision before taking actions. ' +
      'agentLevel indicates nesting depth: 0 = coordinator, 1 = subagent, 2 = subsubagent. ' +
      'If agentLevel >= 2, you MUST NOT spawn any subagents. ' +
      'Only spawn a subagent when it clearly reduces work or parallelizes distinct tasks; otherwise act directly. ' +
      'Avoid useless delegation; do not spawn a subagent just to ask the user a simple question. ' +
      rolePrompt +
      examplePrompt +
      'Coordinator rules: the coordinator MUST NOT call tools. It should delegate to subagents, review their outputs, and then either deliver_subagent_output or finish if it has validated that the output meets the requirements. It may send brief progress updates via send_message, but do not repeat identical messages. ' +
      'Coordinator must never emit tool_call. If a tool is needed, spawn a subagent or use queue_op to delegate tool usage. If the coordinator finishes, it should be because it has confirmed the output meets the requirements it set. ' +
      'Subagent rules: subagents must NEVER message the user directly; they should finish with output for the coordinator. Subagents MUST NOT spawn subagents unless explicitly allowed via inputJson.allowSubagents and agentLevel<2. ' +
      'Use request_parent for a subagent question; the subagent should then wait until the parent replies. Use reply_subagent to answer a subagent. Use retry_subagent to re-run a completed subagent with feedback. ' +
      'You MUST maintain a task queue in state.queue using queue_op. You can only sleep when the queue is empty and at least one subagent is still running (coordinator) or when waitingForParent is true (subagent). ' +
      'Planning quality requirement: for coordinators, produce a very detailed plan (at least 5 numbered steps). ' +
      'The plan must explicitly include: queue_op to build the queue, spawn_subagent(s) with detailed context for each subagent, and deliver_subagent_output. ' +
      'When spawning subagents, include context that specifies: the user request in brief, the exact location/time window, tool(s) to call, expected output format, and success criteria. ' +
      'Subagent task must be specific and scoped; include clear expected output in the context so the subagent can finish without asking follow-ups. ' +
      'If a subagent fails, you must decide whether to retry or stop and explain that decision. ' +
      'Do not repeat the same tool call or spawn the same subagent spec more than once. ' +
      'Coordinator runs may spawn subagents and sleep while they work. ' +
      'Coordinator MUST ensure subagents get all required context (but only the relevant facts). Before spawning, check conversation, transcript, input, and memory. ' +
      'If information is missing, first try to retrieve it via memory.search or memory.sessions and then include it in subagent.context. ' +
      'When retrying after a subagent fails due to missing data, enrich context and try again; ask the user only if retrieval fails. ' +
      'Use sleep with either wakeAt or delaySeconds to resume later (prefer delaySeconds for short waits). ' +
      'Use the conversation and memories fields for user context. ' +
      'If the user asks what tools you have or what you can do, call tools.list. ' +
      'If the user asks for current weather, call tools.list and then the weather tool if available. ' +
      'If a tool returns a missing-parameter error (e.g., region/location required), check memory/search for the value and retry before asking the user. ' +
      'If you need tools, use tool_call and wait for tool_result in the transcript. ' +
      'Use tools.list to see all tools and short descriptions. ' +
      'Use tools.describe to see full details for a specific tool. ' +
      'If the payload contains validationFeedback, you MUST address it explicitly in your next action/output. ' +
      'Process tasks using this internal loop, emitting structured notes so the task dialog shows your work:\n' +
      'Step 1: Output specification (what the user should receive). Emit note(category="requirements").\n' +
      'Step 2: Decision criteria and constraints. Emit note(category="requirements").\n' +
      'Step 3: Resources (tools/memories/context). Emit note(category="plan") summarizing what you will use.\n' +
      'Step 4: Concrete numbered steps with tool calls/parameters. Emit note(category="plan").\n' +
      'Step 5: Execute tasks and summarize partial results. Emit note(category="artifact") as you go.\n' +
      'Step 6: Validate outputs. Emit note(category="validation").\n' +
      'Step 7: Assemble final output. Emit note(category="artifact").\n' +
      'Step 8: Validate final output. Emit note(category="validation").\n' +
      'Step 9: Deliver to user or parent agent.\n' +
      'Error handling: if a task fails, check retry count; retry only when likely to succeed. If not, explain what failed and why, and provide the best alternative.\n\n' +
      toolDescriptions;

    const transcript: TranscriptEntry[] = [];
    let outputText = run.outputText ?? '';
    let lastAssistantMessage = '';
    const toolFailureCounts = new Map<string, number>();
    const noteCounts = {
      requirements: 0,
      plan: 0,
      artifact: 0,
      validation: 0,
    };
    let systemNoteCount = 0;
    const systemNoteCache = new Set<string>();
    const appendSystemNoteOnce = (content: string) => {
      if (systemNoteCache.has(content)) return false;
      systemNoteCache.add(content);
      systemNoteCount += 1;
      transcript.push({ type: 'system_note', content });
      void appendRunStep(db, {
        runId,
        seq: stepSeq++,
        type: 'message',
        resultJson: { event: 'system_note', content },
      });
      return true;
    };
    const normalizeForSimilarity = (text: string) =>
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((token) => token.length > 2);
    const jaccardSimilarity = (a: string, b: string) => {
      const aTokens = new Set(normalizeForSimilarity(a));
      const bTokens = new Set(normalizeForSimilarity(b));
      if (aTokens.size === 0 || bTokens.size === 0) return 0;
      let overlap = 0;
      for (const token of aTokens) {
        if (bTokens.has(token)) overlap += 1;
      }
      const union = aTokens.size + bTokens.size - overlap;
      return union === 0 ? 0 : overlap / union;
    };
    const isTooSimilar = (a: string, b: string, threshold = 0.7) =>
      jaccardSimilarity(a, b) >= threshold;
    const hasNumberedSteps = (text: string) => /(^|\n)\s*\d+\./.test(text);
    const countNumberedSteps = (text: string) =>
      (text.match(/(^|\n)\s*\d+\./g) ?? []).length;
    const hasOutputKeyword = (text: string) =>
      /(output|result|return|provide|deliver|include|list|date|day|criteria|format|best)/i.test(
        text
      );
    const toolNames = toolRegistry.getAllTools().map((tool) => tool.name);
    const mentionsAnyTool = (text: string) =>
      toolNames.some((name) => name && text.toLowerCase().includes(name.toLowerCase()));
    const mentionsCoordinatorOps = (text: string) =>
      /(queue_op|spawn_subagent|spawn_subagents|deliver_subagent_output)/i.test(text);
    const normalizeContextItems = (
      context: Array<{ role: 'user' | 'assistant'; content: string }> | unknown
    ) => {
      if (!Array.isArray(context)) return [];
      return context
        .map((item) => {
          if (item && typeof item === 'object' && 'role' in item && 'content' in item) {
            const typed = item as { role?: 'user' | 'assistant'; content?: string };
            if (typed.role && typeof typed.content === 'string') {
              return { role: typed.role, content: typed.content };
            }
          }
          if (item && typeof item === 'object') {
            return { role: 'user' as const, content: JSON.stringify(item) };
          }
          return null;
        })
        .filter((item): item is { role: 'user' | 'assistant'; content: string } => Boolean(item));
    };
    const ensureSubagentContext = (
      base: Array<{ role: 'user' | 'assistant'; content: string }>,
      details: {
        userRequest: string;
        locationHint?: string;
        timeWindow?: string;
        toolName?: string;
      }
    ) => {
      const joined = base.map((item) => item.content).join('\n');
      const missingOutputFormat = !/expected output format/i.test(joined);
      const missingSuccess = !/(success criteria|done when|acceptance criteria)/i.test(joined);
      const missingSummary = !/user request summary/i.test(joined);
      const additions: string[] = [];
      if (missingSummary) {
        additions.push(`User request summary: ${details.userRequest}`);
      }
      if (details.locationHint) {
        additions.push(`Location/time window: ${details.locationHint}${details.timeWindow ? ` · ${details.timeWindow}` : ''}`);
      }
      if (details.toolName) {
        additions.push(`Tools to use: ${details.toolName}`);
      }
      if (missingOutputFormat) {
        additions.push('Expected output format: concise bullet list with dates, weather conditions, and a single recommended day.');
      }
      if (missingSuccess) {
        additions.push('Success criteria: identify the best day with the safest riding conditions and explain why.');
      }
      if (additions.length === 0) return base;
      return base.concat([{ role: 'user' as const, content: additions.join('\n') }]);
    };
    const hardCap = Math.max(1, config.runMaxIterationsHardCap);
    const minIterations = Math.max(1, config.runMinIterations);
    let runIterationLimit = Math.min(Math.max(minIterations, config.runMaxIterations), hardCap);
    let runLimitsSet = false;
    let limitationRequired = false;
    let limitationReason: string | null = null;
    let rationaleReady = false;
    let forceActionNext = false;
    let actionViolationCount = 0;
    let budgetExceededStrikes = 0;
    const runStartMs = Date.now();
    let progressTick = 0;
    let lastProgressTick = 0;
    let actionCount = 0;
    let lastRequirementsNote = '';
    let lastPlanNote = '';
    let requirementsRewriteRequested = false;
    let planRewriteRequested = false;
    let planRewriteCount = 0;
    let artifactRewriteRequested = false;
    const nudgeCounts = new Map<string, number>();
    let consecutiveNotes = 0;
    const recentIterations: Array<{
      hadToolCall: boolean;
      outputSnapshot: string;
      commandSignature: string | null;
    }> = [];
    let validationAttempts = 0;
    let lastValidatedOutput = '';
    let lastValidationFeedback = '';
    let budgetExceededOnce = false;
    let budgetDecisionLogged = false;
    let lastBudgetDecision: { action: 'extend' | 'finish'; reason: string } | null = null;
    let runtimeWarningSent = false;
    let runLimitsMissingReminders = 0;
    const autoSpawnedToolCalls = new Set<string>();
    let autoRecoverySpawned = false;
    let finishMissingNotesCount = 0;
    let lastFinishOutput = '';
    let finishRepeatCount = 0;
    let finishValidationRetryCount = 0;

    const validateOutput = async (candidate: string, reason: string, payload: unknown) => {
      if (!candidate.trim()) {
        await appendRunStep(db, {
          runId,
          seq: stepSeq++,
          type: 'message',
          resultJson: { event: 'validation_result', reason, decision: 'send', feedback: '', retry: false },
        });
        return { decision: 'send' as const, feedback: '', retry: false };
      }
      if (validationAttempts >= 2) {
        await appendRunStep(db, {
          runId,
          seq: stepSeq++,
          type: 'message',
          resultJson: {
            event: 'validation_result',
            reason,
            decision: 'send',
            feedback: '',
            retry: false,
            error: 'validation_attempts_exceeded',
          },
        });
        return { decision: 'send' as const, feedback: '', retry: false };
      }
      if (candidate === lastValidatedOutput) {
        await appendRunStep(db, {
          runId,
          seq: stepSeq++,
          type: 'message',
          resultJson: {
            event: 'validation_result',
            reason,
            decision: 'send',
            feedback: '',
            retry: false,
            error: 'duplicate_output',
          },
        });
        return { decision: 'send' as const, feedback: '', retry: false };
      }
      const validationSystemPrompt =
        'You are an output validator. Return only JSON: ' +
        '{"decision":"send"|"revise","feedback":"...","retry":true|false}. ' +
        'Use "revise" if the output is misleading, incomplete, or violates constraints. ' +
        'Use "retry": true only if another attempt is likely to improve the result. ' +
        'If the output is a failure/limitation message, decide whether to retry or send as-is.';
      const validationUserPrompt = JSON.stringify({
        reason,
        output: candidate,
        context: payload,
      });
      let responseText = '';
      try {
        responseText = await callOpenAIWithFallback(
          apiKey,
          model,
          fallbackModel,
          [
            { role: 'system', content: validationSystemPrompt },
            { role: 'user', content: validationUserPrompt },
          ],
          { temperature: 0 }
        );
      } catch (error) {
        await appendRunStep(db, {
          runId,
          seq: stepSeq++,
          type: 'message',
          resultJson: {
            event: 'validation_result',
            reason,
            decision: 'send',
            feedback: '',
            retry: false,
            error: 'validator_call_failed',
          },
        });
        return { decision: 'send' as const, feedback: '', retry: false };
      }
      try {
        const parsed = JSON.parse(responseText) as {
          decision?: 'send' | 'revise';
          feedback?: string;
          retry?: boolean;
        };
        let decision = parsed.decision === 'revise' ? 'revise' : 'send';
        const feedback = typeof parsed.feedback === 'string' ? parsed.feedback.trim() : '';
        let retry = Boolean(parsed.retry);
        if (decision === 'revise' && !feedback) {
          decision = 'send';
          retry = false;
        }
        validationAttempts += 1;
        lastValidatedOutput = candidate;
        lastValidationFeedback = feedback;
        await appendRunStep(db, {
          runId,
          seq: stepSeq++,
          type: 'message',
          resultJson: {
            event: 'validation_result',
            reason,
            decision,
            feedback,
            retry,
            ...(parsed.decision === 'revise' && !feedback ? { error: 'non_actionable_feedback' } : {}),
          },
        });
        return { decision, feedback, retry };
      } catch {
        await appendRunStep(db, {
          runId,
          seq: stepSeq++,
          type: 'message',
          resultJson: {
            event: 'validation_result',
            reason,
            decision: 'send',
            feedback: '',
            retry: false,
            error: 'validator_parse_failed',
          },
        });
        return { decision: 'send' as const, feedback: '', retry: false };
      }
    };
    let runState = normalizeRunState((run.inputJson as any)?.state);
    const persistRunState = async (nextState: RunState) => {
      const nextInput = mergeRunInputJson(run.inputJson, nextState);
      await db
        .update(runs)
        .set({ inputJson: nextInput, updatedAt: new Date() })
        .where(eq(runs.id, runId));
      run.inputJson = nextInput;
      runState = nextState;
    };

    const recordBlock = async (reason: string, detail?: string) => {
      const nextState: RunState = {
        ...runState,
        lastBlockReason: reason,
        lastBlockDetail: detail ?? null,
      };
      await persistRunState(nextState);
      await appendRunStep(db, {
        runId,
        seq: stepSeq++,
        type: 'message',
        resultJson: { event: 'action_blocked', reason, detail: detail ?? null },
      });
    };

    const conversation =
      run.kind === 'coordinator'
        ? await loadConversation(db, run.channelId, run.contextId ?? null, undefined)
        : await loadConversation(db, run.channelId, run.contextId ?? null, 40);

    const memories = await loadCoreMemories(db, run.userId);
    const priorSpawnSignatures = await loadPriorSpawnSignatures(db, runId);
    const inputText = (run.inputText ?? '').trim();
    const greetingPattern =
      /^(hi|hey|hello|yo|sup|hola|hallo|guten tag|good (morning|afternoon|evening))\b/i;
    const fallbackMessage = greetingPattern.test(inputText)
      ? 'Hey! How can I help?'
      : "Sorry, I got stuck while planning. Could you rephrase or be more specific?";

    const finishRun = async (message: string, reason: string) => {
      await db
        .update(runs)
        .set({ outputText: message, status: 'completed', updatedAt: new Date() })
        .where(eq(runs.id, runId));
      await appendRunStep(db, {
        runId,
        seq: stepSeq++,
        type: 'finish',
        resultJson: { output: message, reason },
      });
      if (run.kind === 'coordinator') {
        await db
          .update(runs)
          .set({ status: 'cancelled', updatedAt: new Date() })
          .where(
            and(
              eq(runs.parentRunId, runId),
              inArray(runs.status, ['pending', 'running', 'waiting'])
            )
          );
      }
      if (run.kind !== 'subagent') {
        await sendRunMessage({
          db,
          userId: run.userId,
          channelId: run.channelId,
          contextId: run.contextId ?? null,
          content: message,
          logger,
          runId,
          runKind: run.kind ?? 'coordinator',
        });
      }
      logger.info('Run completed', { runId, reason });
      if (run.parentRunId) {
        await wakeParentRun(db, run.parentRunId, tenantId, agentId);
      }
    };

    const spawnRecoverySubagent = async (reason: string) => {
      if (run.kind !== 'coordinator') return false;
      if (autoRecoverySpawned || runState.autoRecoverySpawned) return false;
      autoRecoverySpawned = true;
      await persistRunState({ ...runState, autoRecoverySpawned: true });
      const childRunId = randomUUID();
      const userRequest = (run.inputText ?? '').trim();
      const toolSummary = toolRegistry
        .getAllTools()
        .map((tool) => `${tool.name}: ${tool.commands.map((cmd) => cmd.name).join(', ')}`)
        .join('; ');
      const contextBase = ensureSubagentContext([], { userRequest }).concat([
        {
          role: 'user',
          content:
            `Recovery spawn reason: ${reason}. ` +
            `Available tools (do not invent names): ${toolSummary || 'none'}. ` +
            'If a weather tool exists, use its documented command (e.g., weather.get). ' +
            'If unsure, call tools.list before choosing a tool. If tool calls fail, finish with a limitation statement.',
        },
      ]);
      await db.insert(runs).values({
        id: childRunId,
        tenantId,
        agentId,
        userId: run.userId,
        channelId: run.channelId,
        contextId: run.contextId ?? null,
        parentRunId: runId,
        rootRunId: run.rootRunId ?? runId,
        kind: 'subagent',
        profile: 'recovery',
        inputText: `Resolve the user request end-to-end and provide a final answer for delivery.`,
        inputJson: {
          profile: 'recovery',
          context: contextBase,
          agentLevel: 1,
          state: { queue: [], inbox: [] },
          autoRecovery: true,
        },
        allowedTools: null,
        outputText: '',
        status: 'pending',
      });
      await enqueueRun({
        type: 'run',
        runId: childRunId,
        tenantId,
        agentId,
      });
      await appendRunStep(db, {
        runId,
        seq: stepSeq++,
        type: 'message',
        resultJson: {
          event: 'auto_recovery_spawn',
          subagentRunId: childRunId,
          task: 'Resolve the user request end-to-end and provide a final answer for delivery.',
          context: contextBase,
          reason,
        },
      });
      await db
        .update(runs)
        .set({ status: 'waiting', updatedAt: new Date() })
        .where(eq(runs.id, runId));
      logger.info('Coordinator auto-recovery spawned subagent', { runId, childRunId, reason });
      return true;
    };

    const forceFinishIfStuck = async (iteration: number, reason: string) => {
      if (actionCount === 0) {
        return false;
      }
      const hasToolCalls = transcript.some((entry) => entry.type === 'tool_call');
      const shouldForce =
        iteration >= Math.min(5, config.runMaxIterations - 1) &&
        !outputText &&
        !lastAssistantMessage &&
        !hasToolCalls;
      if (!shouldForce) return false;

      if (run.kind === 'coordinator') {
        await appendRunStep(db, {
          runId,
          seq: stepSeq++,
          type: 'message',
          resultJson: { event: 'note_loop_detected', reason },
        });
        if (await spawnRecoverySubagent(`note_loop:${reason}`)) {
          return true;
        }
        await recordBlock('note_loop', 'Coordinator stuck in notes; waiting for recovery.');
        return true;
      }
      await finishRun(fallbackMessage, reason);
      logger.info('Run completed after planning stall', { runId, iteration, reason });
      return true;
    };

    const recordIterationAndCheck = async (commandSignature: string | null, hadToolCall: boolean) => {
      if (actionCount === 0) {
        return false;
      }
      const outputSnapshot = (outputText || lastAssistantMessage || '').trim();
      recentIterations.push({ hadToolCall, outputSnapshot, commandSignature });
      if (recentIterations.length > 3) {
        recentIterations.shift();
      }
      if (recentIterations.length < 3) return false;

      const noToolCalls = recentIterations.every((entry) => !entry.hadToolCall);
      const sameOutput = recentIterations.every(
        (entry) => entry.outputSnapshot === recentIterations[0].outputSnapshot
      );
      const signatures = new Set(recentIterations.map((entry) => entry.commandSignature ?? ''));
      const sameCommand = signatures.size <= 1;

      if (noToolCalls && sameOutput && sameCommand) {
        appendSystemNoteOnce(
          'You are repeating the same action without new data. Change your approach or provide a best-effort finish instead of retrying.'
        );
        const bestEffort =
          outputSnapshot || 'I need more details or different tools to make progress.';
        const message =
          "I'm not making progress because I'm repeating the same action without new data. " +
          `Here is the best I can do with available information:\n${bestEffort}`;
        await finishRun(message, 'pointless_loop');
        return true;
      }

      return false;
    };

    for (let iteration = 0; iteration < hardCap; iteration += 1) {
      const currentStatusRow = await db
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.id, runId))
        .limit(1);
      const currentStatus = currentStatusRow[0]?.status;
      if (currentStatus === 'cancelled') {
        logger.info('Run cancelled; stopping execution', { runId });
        return;
      }
      if (currentStatus === 'completed' || currentStatus === 'failed' || currentStatus === 'waiting') {
        logger.info('Run no longer active; stopping execution', { runId, status: currentStatus });
        return;
      }
      if (Date.now() - runStartMs > config.runMaxRuntimeMs) {
        if (!runtimeWarningSent) {
          runtimeWarningSent = true;
          appendSystemNoteOnce(
            'Runtime limit reached. Finish now with best-effort output and a brief explanation.'
          );
        } else {
          await finishRun(
            'I reached the maximum allowed runtime while working on this task. Here is the best I can do so far.',
            'max_runtime'
          );
          return;
        }
      }
      if (runtimeWarningSent && Date.now() - runStartMs > config.runMaxRuntimeMs * 1.5) {
        await finishRun(
          'I reached the maximum allowed runtime while working on this task. Here is the best I can do so far.',
          'max_runtime'
        );
        return;
      }
      const budgetExceeded = actionCount > 0 && iteration >= runIterationLimit;
      if (budgetExceeded) {
        if (!budgetExceededOnce) {
          budgetExceededOnce = true;
          budgetDecisionLogged = false;
          lastBudgetDecision = null;
        }
        const notice =
          'Budget reached. Reflect on progress; if stuck, finish with best-effort output and a brief explanation. Otherwise set_run_limits(maxIterations) with a higher limit (<= hard cap) and a brief reason.';
        appendSystemNoteOnce(notice);
      } else if (budgetExceededOnce) {
        budgetExceededOnce = false;
        budgetDecisionLogged = false;
        lastBudgetDecision = null;
      }
      const transcriptWindow = trimTranscript(transcript, config.runTranscriptLimit, config.runTranscriptTokenLimit);

      const subagentResults =
        run.kind === 'coordinator' ? await loadSubagentResults(db, runId) : [];
      const activeSubagentCount =
        run.kind === 'coordinator'
          ? subagentResults.filter(
              (sub) => sub.status !== 'completed' && sub.status !== 'failed'
            ).length
          : 0;

      const agentLevel =
        run.kind === 'subagent' ? ((run.inputJson as any)?.agentLevel ?? 1) : 0;

      const userPayload = {
        task: run.inputText,
        output: outputText,
        conversation,
        transcript: transcriptWindow,
        subagents: subagentResults,
        runKind: run.kind ?? 'coordinator',
        profile: run.profile ?? null,
        input: run.inputJson ?? null,
        memories,
        agentLevel,
        state: runState,
        activeSubagentCount,
        validationFeedback: lastValidationFeedback || null,
        lastBlock: runState.lastBlockReason
          ? { reason: runState.lastBlockReason, detail: runState.lastBlockDetail ?? null }
          : null,
      };

      const messagesForModel: OpenAIMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify(userPayload) },
      ];

      await appendRunStep(db, {
        runId,
        seq: stepSeq++,
        type: 'message',
        resultJson: {
          event: 'llm_request',
          iteration,
          model,
          fallbackModel,
          payload: userPayload,
        },
      });

      if (config.runDebugPrompts) {
        logger.debug(
          { runId, iteration, systemPrompt, userPayload, toolSummary: toolDescriptions },
          'Run prompt'
        );
      }

      let command: RunCommand | null = null;
      let lastResponseText = '';
      for (let attempt = 0; attempt <= config.runMaxJsonRetries; attempt += 1) {
        lastResponseText = await callOpenAIWithFallback(
          apiKey,
          model,
          fallbackModel,
          messagesForModel,
          { temperature: 0 }
        );
        if (config.runDebugPrompts) {
          logger.debug(
            { runId, iteration, attempt, responseText: lastResponseText },
            'Run model response'
          );
        }
        await appendRunStep(db, {
          runId,
          seq: stepSeq++,
          type: 'message',
          resultJson: {
            event: 'llm_response',
            iteration,
            attempt,
            responseText: lastResponseText,
          },
        });
        command = parseRunCommand(lastResponseText);
        if (command) {
          break;
        }
        appendSystemNoteOnce(
          'Invalid JSON response received. Please reply with a single valid JSON command object only.'
        );
      }

      if (!command) {
        await appendRunStep(db, {
          runId,
          seq: stepSeq++,
          type: 'message',
          resultJson: { error: 'invalid_json', rawResponse: lastResponseText.slice(0, 2000) },
        });
        await sendRunMessage({
          db,
          userId: run.userId,
          channelId: run.channelId,
          contextId: run.contextId ?? null,
          content: 'Sorry, I had trouble understanding that request. Please try again.',
          logger,
          runId,
          runKind: run.kind ?? 'coordinator',
        });
        throw new Error('LLM returned invalid JSON for run command');
      }

      const maybeAutoRecover = async () => {
        if (run.kind !== 'coordinator') return false;
        if (autoRecoverySpawned || runState.autoRecoverySpawned) return false;
        if (activeSubagentCount > 0) return false;
        if (systemNoteCount < 3 && planRewriteCount < 2 && blockedSpawnCount < 1) {
          return false;
        }
        autoRecoverySpawned = true;
        await persistRunState({ ...runState, autoRecoverySpawned: true });
        const childRunId = randomUUID();
        const userRequest = (run.inputText ?? '').trim();
        const toolSummary = toolRegistry
          .getAllTools()
          .map((tool) => `${tool.name}: ${tool.commands.map((cmd) => cmd.name).join(', ')}`)
          .join('; ');
        const contextBase = ensureSubagentContext([], {
          userRequest,
        }).concat([
          {
            role: 'user',
            content:
              `Available tools (do not invent names): ${toolSummary || 'none'}. ` +
              'If a weather tool exists, use its documented command (e.g., weather.get). ' +
              'If unsure, call tools.list before choosing a tool. If tool calls fail, finish with a limitation statement.',
          },
        ]);
        await db.insert(runs).values({
          id: childRunId,
          tenantId,
          agentId,
          userId: run.userId,
          channelId: run.channelId,
          contextId: run.contextId ?? null,
          parentRunId: runId,
          rootRunId: run.rootRunId ?? runId,
          kind: 'subagent',
          profile: 'recovery',
          inputText: `Resolve the user request end-to-end and provide a final answer for delivery.`,
          inputJson: {
            profile: 'recovery',
            context: contextBase,
            agentLevel: 1,
            state: { queue: [], inbox: [] },
            autoRecovery: true,
          },
          allowedTools: null,
          outputText: '',
          status: 'pending',
        });
        await enqueueRun({
          type: 'run',
          runId: childRunId,
          tenantId,
          agentId,
        });
        await appendRunStep(db, {
          runId,
          seq: stepSeq++,
          type: 'message',
          resultJson: {
            event: 'auto_recovery_spawn',
            subagentRunId: childRunId,
            task: 'Resolve the user request end-to-end and provide a final answer for delivery.',
            context: contextBase,
          },
        });
        await db
          .update(runs)
          .set({ status: 'waiting', updatedAt: new Date() })
          .where(eq(runs.id, runId));
        logger.info('Coordinator auto-recovery spawned subagent', { runId, childRunId });
        return true;
      };

      if (await maybeAutoRecover()) {
        return;
      }

      if (
        run.kind === 'coordinator' &&
        noteCounts.plan > 0 &&
        !runLimitsSet &&
        iteration >= 2 &&
        command.type !== 'set_run_limits'
      ) {
        runLimitsMissingReminders += 1;
        if (runLimitsMissingReminders <= 2) {
          appendSystemNoteOnce('You must set_run_limits(maxIterations) now or you cannot proceed.');
          if (await recordIterationAndCheck('blocked:set_run_limits', false)) {
            return;
          }
          continue;
        }
        appendSystemNoteOnce(
          'Proceeding without set_run_limits; using the current run budget.'
        );
        runLimitsSet = true;
      }

      const requiresRationale =
        command.type === 'tool_call' ||
        command.type === 'send_message' ||
        command.type === 'deliver_subagent_output' ||
        command.type === 'request_parent' ||
        command.type === 'reply_subagent' ||
        command.type === 'retry_subagent' ||
        command.type === 'queue_op' ||
        command.type === 'set_output' ||
        command.type === 'finish' ||
        command.type === 'spawn_subagent' ||
        command.type === 'spawn_subagents' ||
        command.type === 'sleep';

      const allowFinishWithoutRationale =
        command.type === 'finish' && (budgetExceeded || limitationRequired || runtimeWarningSent);

      if (requiresRationale && !rationaleReady && !allowFinishWithoutRationale) {
        if (
          (command.type === 'spawn_subagent' || command.type === 'spawn_subagents') &&
          noteCounts.artifact > 0
        ) {
          rationaleReady = true;
        } else if (command.type === 'request_parent' && run.kind === 'subagent') {
          rationaleReady = true;
        } else if (command.type === 'finish' && run.kind === 'subagent') {
          rationaleReady = true;
        } else if (command.type === 'tool_call' && run.kind === 'subagent') {
          rationaleReady = true;
        } else {
          appendSystemNoteOnce(
            'Before taking any action, emit note(category="artifact") with exactly one sentence explaining why you are doing the next step and what you are thinking about.'
          );
          await recordBlock('missing_rationale', 'Expected note(category="artifact") before action.');
          continue;
        }
      }

      if (budgetExceeded && command.type !== 'set_run_limits' && command.type !== 'finish') {
        appendSystemNoteOnce(
          'Budget reached. Reflect on progress; if stuck, finish with best-effort output and a brief explanation. Otherwise set_run_limits(maxIterations) with a higher limit (<= hard cap) and a brief reason.'
        );
        budgetExceededStrikes += 1;
        if (budgetExceededStrikes >= 2 && budgetExceededStrikes < 4) {
          appendSystemNoteOnce(
            'Second reminder: you must either set_run_limits to extend the budget or finish now with a reason.'
          );
        }
        if (budgetExceededStrikes >= 4) {
          appendSystemNoteOnce(
            'No budget decision provided after multiple reminders; forcing finish.'
          );
          await finishRun(
            'I hit the run iteration limit before completing the task. Here is the best I can provide right now.',
            'max_iterations'
          );
          return;
        }
        if (await recordIterationAndCheck('blocked:budget', false)) {
          return;
        }
        continue;
      }

      if (limitationRequired && command.type !== 'finish') {
        appendSystemNoteOnce(
          `A required tool failed (${limitationReason ?? 'unknown_error'}). You must finish now with a limitation statement and best-effort output.`
        );
        if (await recordIterationAndCheck('blocked:limitation', false)) {
          return;
        }
        continue;
      }

      if (command.type === 'set_run_limits') {
        actionViolationCount = 0;
        consecutiveNotes = 0;
        const requested = Number(command.maxIterations);
        if (!Number.isFinite(requested) || requested <= 0) {
          appendSystemNoteOnce('set_run_limits requires maxIterations to be a positive number.');
          continue;
        }
        const clamped = Math.max(minIterations, Math.min(hardCap, Math.floor(requested)));
        if (budgetExceeded && actionCount > 0) {
          budgetDecisionLogged = true;
          lastBudgetDecision = {
            action: 'extend',
            reason: command.reason ?? '',
          };
          const noProgress =
            progressTick <= lastProgressTick ||
            (recentIterations.length >= 2 &&
              recentIterations.every((entry) => !entry.hadToolCall) &&
              new Set(recentIterations.map((entry) => entry.outputSnapshot)).size <= 1);
          if (noProgress) {
            await finishRun(
              'I am not making progress and extending the run limit would not help. Here is the best I can provide right now.',
              'budget_stuck'
            );
            return;
          }
          lastProgressTick = progressTick;
        }
        runIterationLimit = clamped;
        runLimitsSet = true;
        budgetExceededStrikes = 0;
        await appendRunStep(db, {
          runId,
          seq: stepSeq++,
          type: 'message',
          resultJson: {
            event: 'set_run_limits',
            maxIterations: clamped,
            reason: command.reason ?? null,
          },
        });
        if (budgetExceeded && actionCount > 0) {
          await appendRunStep(db, {
            runId,
            seq: stepSeq++,
            type: 'message',
            resultJson: {
              event: 'budget_decision',
              action: 'extend',
              reason: command.reason ?? null,
              maxIterations: clamped,
            },
          });
        }
        appendSystemNoteOnce(`Run limits set to ${clamped} iterations.`);
        if (await recordIterationAndCheck(`set_run_limits:${clamped}`, false)) {
          return;
        }
        continue;
      }

      if (command.type === 'tool_call') {
        actionCount += 1;
        rationaleReady = false;
        forceActionNext = false;
        actionViolationCount = 0;
        consecutiveNotes = 0;
        if (!command.name || typeof command.name !== 'string') {
          appendSystemNoteOnce('tool_call requires a non-empty "name" string like "tool.command".');
          if (await recordIterationAndCheck('blocked:tool_call_missing_name', false)) {
            return;
          }
          continue;
        }
        if (run.kind === 'coordinator') {
          const toolCallSignature = stableStringify({
            name: command.name,
            args: command.args ?? {},
          });
          if (!autoSpawnedToolCalls.has(toolCallSignature)) {
            autoSpawnedToolCalls.add(toolCallSignature);
            const childRunId = randomUUID();
            const userRequest = (run.inputText ?? '').trim();
            const contextBase = ensureSubagentContext(
              [{ role: 'user', content: `Tool call requested: ${command.name} ${JSON.stringify(command.args ?? {})}` }],
              {
                userRequest,
                toolName: command.name,
              }
            );
            await db.insert(runs).values({
              id: childRunId,
              tenantId,
              agentId,
              userId: run.userId,
              channelId: run.channelId,
              contextId: run.contextId ?? null,
              parentRunId: runId,
              rootRunId: run.rootRunId ?? runId,
              kind: 'subagent',
              profile: 'auto_tool',
              inputText: `Execute tool ${command.name} and summarize results for the coordinator.`,
              inputJson: {
                profile: 'auto_tool',
                context: contextBase,
                agentLevel: 1,
                state: { queue: [], inbox: [] },
                autoSpawnedFrom: 'tool_call',
              },
              allowedTools: [command.name],
              outputText: '',
              status: 'pending',
            });
            await enqueueRun({
              type: 'run',
              runId: childRunId,
              tenantId,
              agentId,
            });
            await appendRunStep(db, {
              runId,
              seq: stepSeq++,
              type: 'message',
              resultJson: {
                event: 'auto_spawn_from_tool_call',
                tool: command.name,
                args: command.args ?? {},
                runId: childRunId,
                task: `Execute tool ${command.name} and summarize results for the coordinator.`,
              },
            });
            await db
              .update(runs)
              .set({ status: 'waiting', updatedAt: new Date() })
              .where(eq(runs.id, runId));
            logger.info('Coordinator auto-spawned subagent from tool_call', {
              runId,
              childRunId,
              tool: command.name,
            });
            return;
          }
          appendSystemNoteOnce(
            'Coordinator tool calls are blocked. Delegate tool work to subagents instead.'
          );
          if (await recordIterationAndCheck('blocked:coordinator_tool_call', false)) {
            return;
          }
          continue;
        }
        if (noteCounts.requirements === 0 || noteCounts.plan === 0) {
          if (run.kind === 'subagent') {
            const fallbackRequirements =
              (run.inputText ?? '').trim() ||
              'Provide the requested output with best-effort accuracy.';
            const fallbackPlan = '1. Use available tools to gather required data.\n2. Summarize findings clearly.';
            if (noteCounts.requirements === 0) {
              await appendRunStep(db, {
                runId,
                seq: stepSeq++,
                type: 'note',
                resultJson: { category: 'requirements', content: fallbackRequirements },
              });
              transcript.push({
                type: 'note',
                category: 'requirements',
                content: fallbackRequirements,
              });
              noteCounts.requirements += 1;
              lastRequirementsNote = fallbackRequirements;
            }
            if (noteCounts.plan === 0) {
              await appendRunStep(db, {
                runId,
                seq: stepSeq++,
                type: 'note',
                resultJson: { category: 'plan', content: fallbackPlan },
              });
              transcript.push({ type: 'note', category: 'plan', content: fallbackPlan });
              noteCounts.plan += 1;
              lastPlanNote = fallbackPlan;
            }
          } else {
            appendSystemNoteOnce(
              'Before taking actions, emit note(category="requirements") and note(category="plan") summarizing goals, constraints, and plan.'
            );
            if (await forceFinishIfStuck(iteration, 'planning_required')) {
              return;
            }
            if (await recordIterationAndCheck('blocked:planning_required', false)) {
              return;
            }
            continue;
          }
        }
        const toolCall: ToolCall = {
          id: nanoid(),
          name: command.name,
          args: command.args ?? {},
        };

        const toolSignature = `tool:${toolCall.name}:${stableStringify(toolCall.args)}`;
        const toolCount = (repeatedCallCounts.get(toolSignature) ?? 0) + 1;
        repeatedCallCounts.set(toolSignature, toolCount);
        if (toolCount > 2) {
          const message = `Detected repeated tool call loop for "${toolCall.name}". Stopping to avoid infinite retries.`;
          await appendRunStep(db, {
            runId,
            seq: stepSeq++,
            type: 'message',
            resultJson: { event: 'loop_detected', kind: 'tool', name: toolCall.name },
          });
          await db
            .update(runs)
            .set({ outputText: message, status: 'failed', updatedAt: new Date() })
            .where(eq(runs.id, runId));
          if (run.kind !== 'subagent') {
            await sendRunMessage({
              db,
              userId: run.userId,
              channelId: run.channelId,
              contextId: run.contextId ?? null,
              content: message,
              logger,
              runId,
              runKind: run.kind ?? 'coordinator',
            });
          }
          return;
        }

        transcript.push({ type: 'tool_call', name: toolCall.name, args: toolCall.args });

        if (config.runDebugPrompts) {
          logger.debug(
            { runId, iteration, toolCall: truncateForLog(toolCall) },
            'Run tool call'
          );
        }

        const result = await executeToolCall(toolCall, {
          runId,
          tenantId,
          agentId,
          baseSeq: stepSeq,
          toolRegistry,
          policyEngine,
          db,
          logger,
          toolConfigMap,
          run,
        });

        stepSeq += 2;
        transcript.push({ type: 'tool_result', name: toolCall.name, result });
        if (config.runDebugPrompts) {
          logger.debug(
            { runId, iteration, toolResult: truncateForLog(result) },
            'Run tool result'
          );
        }
        const toolResultSignature = `tool_result:${toolCall.name}:${stableStringify(
          toolCall.args
        )}:${stableStringify(result)}`;
        const resultCount = (repeatedResultCounts.get(toolResultSignature) ?? 0) + 1;
        repeatedResultCounts.set(toolResultSignature, resultCount);
        if (result.success) {
          progressTick += 1;
        }
        if (resultCount >= 2) {
          limitationRequired = true;
          limitationReason = 'repeated_tool_result';
          appendSystemNoteOnce(
            'The same tool call produced the same result multiple times. Change strategy (e.g., adjust parameters or split the request) or finish with a limitation.'
          );
        }
        if (!result.success) {
          const key = toolCall.name;
          const count = (toolFailureCounts.get(key) ?? 0) + 1;
          toolFailureCounts.set(key, count);
          const toolConfig = toolConfigMap.get(key.split('.')[0] ?? key) ?? {};
          const maxRetries =
            typeof (toolConfig as { max_retries?: unknown }).max_retries === 'number'
              ? Number((toolConfig as { max_retries?: number }).max_retries)
              : config.runMaxToolRetries;
          lastToolError = {
            tool: toolCall.name,
            error: typeof result.error === 'string' ? result.error : undefined,
          };
          if (count > maxRetries) {
            const exposeErrors = Boolean((toolConfig as { expose_errors?: unknown }).expose_errors);
            const errorText = exposeErrors && result.error ? String(result.error) : 'tool_failed';
            limitationRequired = true;
            limitationReason = errorText;
            appendSystemNoteOnce(
              `Tool \"${toolCall.name}\" failed (${errorText}). You must finish now with a limitation statement and best-effort output.`
            );
          }
        }
        if (await recordIterationAndCheck(`tool_call:${toolCall.name}`, true)) {
          return;
        }
        continue;
      }

      if (command.type === 'send_message') {
        actionCount += 1;
        rationaleReady = false;
        forceActionNext = false;
        actionViolationCount = 0;
        consecutiveNotes = 0;
        const message = command.message?.trim();
        if (!message) {
          appendSystemNoteOnce('send_message requires a non-empty "message".');
          if (await recordIterationAndCheck('blocked:send_message_missing', false)) {
            return;
          }
          continue;
        }

        if (run.kind !== 'coordinator') {
          appendSystemNoteOnce(
            'send_message is only valid for coordinators. Subagents should use request_parent (if blocked) or finish with output for the coordinator.'
          );
          if (await recordIterationAndCheck('blocked:send_message_non_coordinator', false)) {
            return;
          }
          continue;
        }

        if (message === lastAssistantMessage) {
          appendSystemNoteOnce(
            'Duplicate send_message blocked. Provide a different progress update or wait for subagents.'
          );
          if (await recordIterationAndCheck('blocked:duplicate_message', false)) {
            return;
          }
          continue;
        }

        await appendRunStep(db, {
          runId,
          seq: stepSeq++,
          type: 'assistant_message',
          resultJson: { message },
        });

        const sent = await sendRunMessage({
          db,
          userId: run.userId,
          channelId: run.channelId,
          contextId: run.contextId ?? null,
          content: message,
          logger,
          runId,
          runKind: run.kind ?? 'coordinator',
        });
        if (!sent) {
          await appendRunStep(db, {
            runId,
            seq: stepSeq++,
            type: 'message',
            resultJson: { event: 'send_message_failed' },
          });
        }

        transcript.push({ type: 'assistant_message', content: message });
        lastAssistantMessage = message;

        const hasToolCalls = transcriptWindow.some((entry) => entry.type === 'tool_call');
        const hasOutputUpdates = transcriptWindow.some((entry) => entry.type === 'output_update');
        const asksUser =
          message.trim().endsWith('?') ||
          /bitte|please|could you|can you/i.test(message);
        if ((!hasToolCalls && !hasOutputUpdates && !outputText) || asksUser || toolFailureCounts.size > 0) {
          const validation = await validateOutput(message, 'send_message', userPayload);
          if (validation.decision === 'revise') {
            appendSystemNoteOnce(
              `Validation requested changes: ${validation.feedback || 'Improve clarity and correctness.'}`
            );
            await appendRunStep(db, {
              runId,
              seq: stepSeq++,
              type: 'message',
              resultJson: { event: 'validation_feedback', feedback: validation.feedback, retry: validation.retry },
            });
            if (validation.retry) {
              limitationRequired = false;
              limitationReason = null;
            }
            continue;
          }
          await finishRun(message, 'send_message_direct');
          return;
        }
        if (await recordIterationAndCheck('send_message', false)) {
          return;
        }
        continue;
      }

      if (command.type === 'queue_op') {
        actionCount += 1;
        rationaleReady = false;
        forceActionNext = false;
        actionViolationCount = 0;
        consecutiveNotes = 0;
        if (run.kind !== 'coordinator') {
          appendSystemNoteOnce('queue_op is only valid for coordinators.');
          if (await recordIterationAndCheck('blocked:queue_op_non_coordinator', false)) {
            return;
          }
          continue;
        }
        if (noteCounts.requirements === 0 || noteCounts.plan === 0) {
          appendSystemNoteOnce(
            'Before updating the queue, emit note(category="requirements") and note(category="plan").'
          );
          await recordBlock('missing_requirements_or_plan', 'queue_op requires requirements and plan notes.');
          if (await forceFinishIfStuck(iteration, 'planning_required')) {
            return;
          }
          if (await recordIterationAndCheck('blocked:planning_required', false)) {
            return;
          }
          continue;
        }

        const action = command.action;
        const items = Array.isArray(command.items)
          ? command.items.filter((item) => typeof item === 'string')
          : [];
        let nextQueue = [...runState.queue];
        if (action === 'push') {
          nextQueue = nextQueue.concat(items);
        } else if (action === 'shift') {
          nextQueue.shift();
        } else if (action === 'clear') {
          nextQueue = [];
        } else if (action === 'set') {
          nextQueue = items;
        } else {
          appendSystemNoteOnce('queue_op requires a valid action.');
          if (await recordIterationAndCheck('blocked:queue_op_invalid', false)) {
            return;
          }
          continue;
        }

        const nextState: RunState = { ...runState, queue: nextQueue };
        await persistRunState(nextState);
        await appendRunStep(db, {
          runId,
          seq: stepSeq++,
          type: 'message',
          resultJson: { event: 'queue_op', action, queueLength: nextQueue.length },
        });
        if (await recordIterationAndCheck('queue_op', false)) {
          return;
        }
        continue;
      }

      if (command.type === 'deliver_subagent_output') {
        actionCount += 1;
        rationaleReady = false;
        forceActionNext = false;
        actionViolationCount = 0;
        consecutiveNotes = 0;
        if (run.kind !== 'coordinator') {
          appendSystemNoteOnce('deliver_subagent_output is only valid for coordinators.');
          if (await recordIterationAndCheck('blocked:deliver_non_coordinator', false)) {
            return;
          }
          continue;
        }
        if (!command.runId || typeof command.runId !== 'string') {
          appendSystemNoteOnce('deliver_subagent_output requires a valid "runId" string.');
          if (await recordIterationAndCheck('blocked:deliver_missing_runid', false)) {
            return;
          }
          continue;
        }
        if (noteCounts.requirements === 0 || noteCounts.plan === 0) {
          appendSystemNoteOnce(
            'Before delivering output, emit note(category="requirements") and note(category="plan").'
          );
          await recordBlock('missing_requirements_or_plan', 'deliver_subagent_output requires requirements and plan notes.');
          if (await forceFinishIfStuck(iteration, 'planning_required')) {
            return;
          }
          if (await recordIterationAndCheck('blocked:planning_required', false)) {
            return;
          }
          continue;
        }
        const [child] = await db
          .select()
          .from(runs)
          .where(and(eq(runs.id, command.runId), eq(runs.parentRunId, runId)))
          .limit(1);
        if (!child) {
          appendSystemNoteOnce('Subagent run not found or not a child of this coordinator.');
          if (await recordIterationAndCheck('blocked:deliver_missing_subagent', false)) {
            return;
          }
          continue;
        }
        if (child.status !== 'completed') {
          appendSystemNoteOnce('Subagent is not completed yet; wait for it to finish before delivering output.');
          await appendRunStep(db, {
            runId,
            seq: stepSeq++,
            type: 'message',
            resultJson: { event: 'deliver_waiting_for_subagent', subagentRunId: child.id },
          });
          const delaySeconds = 30;
          const wakeAtDate = new Date(Date.now() + delaySeconds * 1000);
          await db
            .update(runs)
            .set({
              status: 'waiting',
              wakeAt: wakeAtDate,
              wakeReason: 'waiting_for_subagent',
              updatedAt: new Date(),
            })
            .where(eq(runs.id, runId));
          await enqueueRunWake({
            type: 'run',
            runId,
            tenantId,
            agentId,
            delaySeconds,
            reason: 'waiting_for_subagent',
          });
          logger.info('Coordinator waiting for subagent completion', {
            runId,
            subagentRunId: child.id,
          });
          return;
        }
        const output = (child.outputText ?? '').trim();
        if (!output) {
          appendSystemNoteOnce('Subagent output is empty; retry the subagent or provide feedback.');
          if (await recordIterationAndCheck('blocked:deliver_empty_output', false)) {
            return;
          }
          continue;
        }
        await finishRun(output, 'deliver_subagent_output');
        return;
      }

      if (command.type === 'request_parent') {
        actionCount += 1;
        rationaleReady = false;
        forceActionNext = false;
        actionViolationCount = 0;
        consecutiveNotes = 0;
        const message = command.message?.trim();
        if (!message) {
          appendSystemNoteOnce('request_parent requires a non-empty "message".');
          if (await recordIterationAndCheck('blocked:request_parent_missing', false)) {
            return;
          }
          continue;
        }
        if (run.kind !== 'subagent') {
          appendSystemNoteOnce(
            'request_parent is only valid for subagents. Coordinators should reply_subagent, retry_subagent, or spawn new subagents instead.'
          );
          if (await recordIterationAndCheck('blocked:request_parent_non_subagent', false)) {
            return;
          }
          continue;
        }
        if (runState.lastRequestParentMessage === message) {
          const nextCount = (runState.requestParentRepeatCount ?? 0) + 1;
          const updatedState = {
            ...runState,
            requestParentRepeatCount: nextCount,
          };
          await persistRunState(updatedState);
          if (nextCount >= 1) {
            await finishRun(
              'I already asked the parent for help and did not receive new guidance. ' +
                'I am stopping to avoid a loop.',
              'request_parent_repeat'
            );
            return;
          }
        }
        await persistRunState({
          ...runState,
          lastRequestParentMessage: message,
          requestParentRepeatCount: 0,
        });
        if (!run.parentRunId) {
          appendSystemNoteOnce('Subagent is missing parentRunId; cannot request parent.');
          if (await recordIterationAndCheck('blocked:request_parent_no_parent', false)) {
            return;
          }
          continue;
        }
        const [parent] = await db
          .select()
          .from(runs)
          .where(eq(runs.id, run.parentRunId))
          .limit(1);
        if (!parent) {
          appendSystemNoteOnce('Parent run not found.');
          if (await recordIterationAndCheck('blocked:request_parent_missing_parent', false)) {
            return;
          }
          continue;
        }
        const parentState = normalizeRunState((parent.inputJson as any)?.state);
        parentState.inbox.push({
          fromRunId: runId,
          message,
          at: new Date().toISOString(),
        });
        const parentInput = mergeRunInputJson(parent.inputJson, parentState);
        await db
          .update(runs)
          .set({ inputJson: parentInput, updatedAt: new Date() })
          .where(eq(runs.id, parent.id));
        await wakeParentRun(db, parent.id, tenantId, agentId);

        await persistRunState({ ...runState, waitingForParent: true });
        await appendRunStep(db, {
          runId,
          seq: stepSeq++,
          type: 'message',
          resultJson: { event: 'request_parent', parentRunId: parent.id },
        });
        await db
          .update(runs)
          .set({
            status: 'waiting',
            wakeAt: null,
            wakeReason: 'waiting_for_parent',
            updatedAt: new Date(),
          })
          .where(eq(runs.id, runId));
        logger.info('Subagent waiting for parent response', { runId, parentRunId: parent.id });
        return;
      }

      if (command.type === 'reply_subagent') {
        actionCount += 1;
        rationaleReady = false;
        forceActionNext = false;
        actionViolationCount = 0;
        consecutiveNotes = 0;
        const message = command.message?.trim();
        if (!message) {
          appendSystemNoteOnce('reply_subagent requires a non-empty "message".');
          if (await recordIterationAndCheck('blocked:reply_missing_message', false)) {
            return;
          }
          continue;
        }
        if (!command.runId || typeof command.runId !== 'string') {
          appendSystemNoteOnce('reply_subagent requires a valid "runId" string.');
          if (await recordIterationAndCheck('blocked:reply_missing_runid', false)) {
            return;
          }
          continue;
        }
        if (run.kind !== 'coordinator') {
          appendSystemNoteOnce('reply_subagent is only valid for coordinators.');
          if (await recordIterationAndCheck('blocked:reply_non_coordinator', false)) {
            return;
          }
          continue;
        }
        const [child] = await db
          .select()
          .from(runs)
          .where(and(eq(runs.id, command.runId), eq(runs.parentRunId, runId)))
          .limit(1);
        if (!child) {
          appendSystemNoteOnce('Subagent run not found or not a child of this coordinator.');
          if (await recordIterationAndCheck('blocked:reply_missing_subagent', false)) {
            return;
          }
          continue;
        }
        const childState = normalizeRunState((child.inputJson as any)?.state);
        childState.inbox.push({
          fromRunId: runId,
          message,
          at: new Date().toISOString(),
        });
        childState.waitingForParent = false;
        const childInput = mergeRunInputJson(child.inputJson, childState);
        await db
          .update(runs)
          .set({ inputJson: childInput, status: 'pending', updatedAt: new Date() })
          .where(eq(runs.id, child.id));
        await enqueueRun({
          type: 'run',
          runId: child.id,
          tenantId,
          agentId,
        });
        await appendRunStep(db, {
          runId,
          seq: stepSeq++,
          type: 'message',
          resultJson: { event: 'reply_subagent', subagentRunId: child.id },
        });
        if (await recordIterationAndCheck('reply_subagent', false)) {
          return;
        }
        continue;
      }

      if (command.type === 'retry_subagent') {
        actionCount += 1;
        rationaleReady = false;
        forceActionNext = false;
        actionViolationCount = 0;
        consecutiveNotes = 0;
        if (run.kind !== 'coordinator') {
          appendSystemNoteOnce('retry_subagent is only valid for coordinators.');
          if (await recordIterationAndCheck('blocked:retry_non_coordinator', false)) {
            return;
          }
          continue;
        }
        if (!command.runId || typeof command.runId !== 'string') {
          appendSystemNoteOnce('retry_subagent requires a valid "runId" string.');
          if (await recordIterationAndCheck('blocked:retry_missing_runid', false)) {
            return;
          }
          continue;
        }
        const [child] = await db
          .select()
          .from(runs)
          .where(and(eq(runs.id, command.runId), eq(runs.parentRunId, runId)))
          .limit(1);
        if (!child) {
          appendSystemNoteOnce('Subagent run not found or not a child of this coordinator.');
          if (await recordIterationAndCheck('blocked:retry_missing_subagent', false)) {
            return;
          }
          continue;
        }
        const childInput = (child.inputJson as any) ?? {};
        const baseContext = Array.isArray(childInput.context) ? childInput.context : [];
        const feedback = command.feedback?.trim() ?? '';
        const retryContext = [
          ...baseContext,
          ...(child.outputText
            ? [{ role: 'assistant', content: `Previous output: ${child.outputText}` }]
            : []),
          ...(feedback ? [{ role: 'user', content: `Feedback: ${feedback}` }] : []),
        ];
        const childAgentLevel =
          typeof childInput.agentLevel === 'number' ? childInput.agentLevel : 1;
        const retryRunId = randomUUID();
        await db.insert(runs).values({
          id: retryRunId,
          tenantId,
          agentId,
          userId: run.userId,
          channelId: run.channelId,
          contextId: run.contextId ?? null,
          parentRunId: runId,
          rootRunId: run.rootRunId ?? runId,
          kind: 'subagent',
          profile: child.profile ?? null,
          inputText: child.inputText ?? '',
          inputJson: {
            profile: child.profile ?? null,
            context: retryContext,
            agentLevel: Math.min(2, Math.max(1, childAgentLevel)),
            state: { queue: [], inbox: [] },
            retryOf: child.id,
          },
          allowedTools: child.allowedTools ?? [],
          outputText: '',
          status: 'pending',
        });
        await enqueueRun({
          type: 'run',
          runId: retryRunId,
          tenantId,
          agentId,
        });
        await appendRunStep(db, {
          runId,
          seq: stepSeq++,
          type: 'message',
          resultJson: { event: 'retry_subagent', subagentRunId: retryRunId, retryOf: child.id },
        });
        await db
          .update(runs)
          .set({ status: 'waiting', updatedAt: new Date() })
          .where(eq(runs.id, runId));
        logger.info('Coordinator waiting for retried subagent', { runId, retryRunId });
        return;
      }

      if (command.type === 'set_output') {
        actionCount += 1;
        rationaleReady = false;
        forceActionNext = false;
        actionViolationCount = 0;
        consecutiveNotes = 0;
        if (!command.output || typeof command.output !== 'string') {
          appendSystemNoteOnce('set_output requires a non-empty "output" string.');
          if (await recordIterationAndCheck('blocked:set_output_missing', false)) {
            return;
          }
          continue;
        }
        if (run.kind === 'coordinator') {
          appendSystemNoteOnce(
            'Coordinator must not generate output directly. Use deliver_subagent_output from a completed subagent.'
          );
          if (await recordIterationAndCheck('blocked:coordinator_set_output', false)) {
            return;
          }
          continue;
        }
        if (noteCounts.requirements === 0 || noteCounts.plan === 0) {
          appendSystemNoteOnce(
            'Before producing output, emit note(category="requirements") and note(category="plan").'
          );
          await recordBlock('missing_requirements_or_plan', 'set_output requires requirements and plan notes.');
          if (await forceFinishIfStuck(iteration, 'planning_required')) {
            return;
          }
          if (await recordIterationAndCheck('blocked:planning_required', false)) {
            return;
          }
          continue;
        }
        const nextOutput = applyOutputUpdate(outputText, command.output, command.mode);
        const outputChanged = nextOutput !== outputText;
        outputText = nextOutput;
        if (outputChanged) {
          progressTick += 1;
        }

        await db
          .update(runs)
          .set({ outputText, updatedAt: new Date() })
          .where(eq(runs.id, runId));

        await appendRunStep(db, {
          runId,
          seq: stepSeq++,
          type: 'output_update',
          resultJson: { output: command.output, mode: command.mode ?? 'replace' },
        });

        transcript.push({
          type: 'output_update',
          output: command.output,
          mode: command.mode ?? 'replace',
        });
        const validation = await validateOutput(outputText, 'set_output', userPayload);
        if (validation.decision === 'revise') {
          appendSystemNoteOnce(
            `Validation requested changes: ${validation.feedback || 'Improve completeness and correctness.'}`
          );
          await appendRunStep(db, {
            runId,
            seq: stepSeq++,
            type: 'message',
            resultJson: { event: 'validation_feedback', feedback: validation.feedback, retry: validation.retry },
          });
          if (validation.retry) {
            limitationRequired = false;
            limitationReason = null;
          }
          continue;
        }
        if (await recordIterationAndCheck('set_output', false)) {
          return;
        }
        continue;
      }

      if (command.type === 'decision') {
        const content = command.content?.trim();
        if (!content) {
          appendSystemNoteOnce('decision requires non-empty "content".');
          if (await recordIterationAndCheck('blocked:decision_missing', false)) {
            return;
          }
          continue;
        }
        await appendRunStep(db, {
          runId,
          seq: stepSeq++,
          type: 'decision',
          resultJson: { content, importance: command.importance ?? 'normal' },
        });
        transcript.push({ type: 'decision', content, importance: command.importance ?? 'normal' });
        if (budgetExceeded) {
          budgetDecisionLogged = true;
          const isExtend = /(extend|increase|more iterations|continue)/i.test(content);
          lastBudgetDecision = { action: isExtend ? 'extend' : 'finish', reason: content };
          await appendRunStep(db, {
            runId,
            seq: stepSeq++,
            type: 'message',
            resultJson: {
              event: 'budget_decision',
              action: lastBudgetDecision.action,
              reason: content,
            },
          });
        }
        if (await forceFinishIfStuck(iteration, 'decision_loop')) {
          return;
        }
        if (await recordIterationAndCheck('decision', false)) {
          return;
        }
        continue;
      }

      if (command.type === 'note') {
        const content = command.content?.trim();
        if (!content) {
          appendSystemNoteOnce('note requires non-empty "content".');
          if (await recordIterationAndCheck('blocked:note_missing', false)) {
            return;
          }
          continue;
        }
        consecutiveNotes += 1;
        if (forceActionNext) {
          if (command.category !== 'artifact') {
            const reason = 'post_rationale_note';
            if (consecutiveNotes >= 3) {
              const nextCount = (nudgeCounts.get(reason) ?? 0) + 1;
              if (nextCount <= 2) {
                nudgeCounts.set(reason, nextCount);
                const nudge =
                  nextCount === 1
                    ? 'You already provided the rationale. Your next response must be an action (tool_call, send_message, deliver_subagent_output, request_parent, reply_subagent, retry_subagent, queue_op, set_output, finish, spawn, sleep).'
                    : 'Second reminder: stop emitting notes and take the next action now (tool_call, send_message, deliver_subagent_output, request_parent, reply_subagent, retry_subagent, queue_op, set_output, finish, spawn, sleep).';
                appendSystemNoteOnce(nudge);
              }
            }
            continue;
          }
          actionViolationCount += 1;
          const reason = 'post_rationale_artifact';
          if (consecutiveNotes >= 3) {
            const nextCount = (nudgeCounts.get(reason) ?? 0) + 1;
            if (nextCount <= 2) {
              nudgeCounts.set(reason, nextCount);
              const nudge =
                nextCount === 1
                  ? 'You already provided the rationale. Your next response must be an action (tool_call, send_message, deliver_subagent_output, request_parent, reply_subagent, retry_subagent, queue_op, set_output, finish, spawn, sleep).'
                  : 'Second reminder: stop emitting notes and take the next action now (tool_call, send_message, deliver_subagent_output, request_parent, reply_subagent, retry_subagent, queue_op, set_output, finish, spawn, sleep).';
              appendSystemNoteOnce(nudge);
            }
          }
          continue;
        }
        if (command.category === 'artifact' && rationaleReady) {
          appendSystemNoteOnce(
            'You already provided the rationale. Take the next action now (tool_call, send_message, deliver_subagent_output, request_parent, reply_subagent, retry_subagent, queue_op, set_output, finish, spawn, sleep).'
          );
          continue;
        }
        if (command.category === 'requirements' && !requirementsRewriteRequested) {
          const tooSimilarToTask = run.inputText
            ? isTooSimilar(content, run.inputText)
            : false;
          const tooSimilarToPlan =
            lastPlanNote && isTooSimilar(content, lastPlanNote);
          if (tooSimilarToTask || tooSimilarToPlan || !hasOutputKeyword(content)) {
            appendSystemNoteOnce(
              'Rewrite requirements as an output specification and decision criteria (what the user will receive), not a restatement of the task.'
            );
            requirementsRewriteRequested = true;
            continue;
          }
        }
        if (command.category === 'plan' && !planRewriteRequested) {
          const tooSimilarToTask = run.inputText
            ? isTooSimilar(content, run.inputText)
            : false;
          const tooSimilarToRequirements =
            lastRequirementsNote && isTooSimilar(content, lastRequirementsNote);
          const taskHintsTools = run.inputText
            ? /(weather|forecast|wetter|temperature|rain|snow)/i.test(run.inputText)
            : false;
          const missingTools =
            toolNames.length > 0 && taskHintsTools && !mentionsAnyTool(content);
          const stepCount = countNumberedSteps(content);
          const coordinatorMissingOps =
            run.kind === 'coordinator' && !mentionsCoordinatorOps(content);
          const coordinatorTooShort =
            run.kind === 'coordinator' && stepCount > 0 && stepCount < 5;
          const coordinatorMissingOutputFormat =
            run.kind === 'coordinator' && !/(expected output format|output format)/i.test(content);
          const coordinatorMissingSuccess =
            run.kind === 'coordinator' &&
            !/(success criteria|acceptance criteria|done when)/i.test(content);
          const coordinatorMissingContext =
            run.kind === 'coordinator' && !/(subagent context|context for subagent)/i.test(content);
          if (
            tooSimilarToTask ||
            tooSimilarToRequirements ||
            !hasNumberedSteps(content) ||
            missingTools ||
            coordinatorMissingOps ||
            coordinatorTooShort ||
            coordinatorMissingOutputFormat ||
            coordinatorMissingSuccess ||
            coordinatorMissingContext
          ) {
            planRewriteCount += 1;
            appendSystemNoteOnce(
              'Rewrite plan as detailed numbered steps (at least 5 for coordinators). ' +
                'Name the tools you will call and key parameters (e.g., date ranges). ' +
                'For coordinators, include queue_op, spawn_subagent(s), and deliver_subagent_output steps, ' +
                'and explicitly state expected output format and success criteria, plus the subagent context requirements.'
            );
            planRewriteRequested = true;
            if (planRewriteCount >= 2) {
              await appendRunStep(db, {
                runId,
                seq: stepSeq++,
                type: 'message',
                resultJson: { event: 'plan_loop_detected', count: planRewriteCount },
              });
            }
            continue;
          }
        }
        if (command.category === 'artifact' && !artifactRewriteRequested) {
          const tooSimilarToRequirements =
            lastRequirementsNote && isTooSimilar(content, lastRequirementsNote, 0.6);
          const tooSimilarToPlan =
            lastPlanNote && isTooSimilar(content, lastPlanNote, 0.6);
          if (tooSimilarToRequirements || tooSimilarToPlan) {
            appendSystemNoteOnce(
              'Rewrite the artifact as a single sentence about the immediate next step you are about to take (do not repeat requirements or plan).'
            );
            artifactRewriteRequested = true;
            continue;
          }
        }
        await appendRunStep(db, {
          runId,
          seq: stepSeq++,
          type: 'note',
          resultJson: { category: command.category, content },
        });
        transcript.push({ type: 'note', category: command.category, content });
        if (command.category === 'requirements') noteCounts.requirements += 1;
        if (command.category === 'plan') noteCounts.plan += 1;
        if (command.category === 'artifact') noteCounts.artifact += 1;
        if (command.category === 'validation') noteCounts.validation += 1;
        if (command.category === 'requirements') lastRequirementsNote = content;
        if (command.category === 'plan') lastPlanNote = content;
        if (command.category === 'artifact') {
          rationaleReady = true;
          forceActionNext = true;
        }
        if (await forceFinishIfStuck(iteration, 'note_loop')) {
          return;
        }
        if (command.category !== 'artifact') {
          if (await recordIterationAndCheck(`note:${command.category}`, false)) {
            return;
          }
        }
        continue;
      }

      if (command.type === 'finish') {
        actionCount += 1;
        rationaleReady = false;
        forceActionNext = false;
        actionViolationCount = 0;
        consecutiveNotes = 0;
        if (run.kind === 'coordinator') {
          if (noteCounts.requirements === 0 || noteCounts.plan === 0) {
            finishMissingNotesCount += 1;
            appendSystemNoteOnce(
              'Finish blocked: before finishing, you must emit note(category="requirements") and note(category="plan") that define output criteria.'
            );
            if (finishMissingNotesCount < 2) {
              if (await recordIterationAndCheck('blocked:finish_missing_notes', false)) {
                return;
              }
              continue;
            }
            const fallbackRequirements =
              'Deliver a final answer that matches the requested output and meets safety/quality criteria.';
            const fallbackPlan =
              '1. Review subagent outputs.\n2. Validate against requirements.\n3. Finish with the best result.';
            await appendRunStep(db, {
              runId,
              seq: stepSeq++,
              type: 'note',
              resultJson: { category: 'requirements', content: fallbackRequirements },
            });
            await appendRunStep(db, {
              runId,
              seq: stepSeq++,
              type: 'note',
              resultJson: { category: 'plan', content: fallbackPlan },
            });
            await appendRunStep(db, {
              runId,
              seq: stepSeq++,
              type: 'note',
              resultJson: { category: 'validation', content: 'Coordinator override: proceeding to finish.' },
            });
            noteCounts.requirements += 1;
            noteCounts.plan += 1;
            noteCounts.validation += 1;
            lastRequirementsNote = fallbackRequirements;
            lastPlanNote = fallbackPlan;
          }
        }
        if (run.kind === 'subagent') {
          if (noteCounts.requirements === 0 || noteCounts.plan === 0) {
            const fallbackRequirements =
              (run.inputText ?? '').trim() ||
              'Provide the requested output with best-effort accuracy.';
            const fallbackPlan =
              '1. Use available tools to gather required data.\n2. Summarize findings clearly.';
            if (noteCounts.requirements === 0) {
              await appendRunStep(db, {
                runId,
                seq: stepSeq++,
                type: 'note',
                resultJson: { category: 'requirements', content: fallbackRequirements },
              });
              transcript.push({
                type: 'note',
                category: 'requirements',
                content: fallbackRequirements,
              });
              noteCounts.requirements += 1;
              lastRequirementsNote = fallbackRequirements;
            }
            if (noteCounts.plan === 0) {
              await appendRunStep(db, {
                runId,
                seq: stepSeq++,
                type: 'note',
                resultJson: { category: 'plan', content: fallbackPlan },
              });
              transcript.push({ type: 'note', category: 'plan', content: fallbackPlan });
              noteCounts.plan += 1;
              lastPlanNote = fallbackPlan;
            }
          }
        }
        if (budgetExceeded && actionCount > 0 && !budgetDecisionLogged && !runtimeWarningSent) {
          if (run.kind === 'subagent') {
            // Subagents can finish without a budget decision to avoid loops.
            budgetDecisionLogged = true;
          } else {
          appendSystemNoteOnce(
            'Budget reached. Before finishing, emit a decision explaining why stopping now is the right choice.'
          );
          if (await recordIterationAndCheck('blocked:budget_decision', false)) {
            return;
          }
          continue;
          }
        }
        if (noteCounts.requirements === 0 || noteCounts.plan === 0) {
          appendSystemNoteOnce(
            'Before finishing, emit note(category="requirements") and note(category="plan").'
          );
          await appendRunStep(db, {
            runId,
            seq: stepSeq++,
            type: 'message',
            resultJson: { event: 'finish_blocked', reason: 'missing_requirements_or_plan' },
          });
          await recordBlock('missing_requirements_or_plan', 'finish requires requirements and plan notes.');
          if (await forceFinishIfStuck(iteration, 'planning_required')) {
            return;
          }
          if (await recordIterationAndCheck('blocked:planning_required', false)) {
            return;
          }
          continue;
        }
        if (noteCounts.validation === 0) {
          transcript.push({
            type: 'validation_missing',
            detail: 'finish accepted without validation note',
          });
        }
        if (command.output) {
          outputText = applyOutputUpdate(outputText, command.output, command.mode);
        }

        const finalOutput = outputText.trim() || lastAssistantMessage.trim();
        if (!finalOutput) {
          appendSystemNoteOnce('finish requires an "output" or a prior assistant message to finalize.');
          await appendRunStep(db, {
            runId,
            seq: stepSeq++,
            type: 'message',
            resultJson: { event: 'finish_blocked', reason: 'missing_output' },
          });
          if (await recordIterationAndCheck('blocked:finish_missing_output', false)) {
            return;
          }
          continue;
        }
        if (finalOutput === lastFinishOutput) {
          finishRepeatCount += 1;
        } else {
          lastFinishOutput = finalOutput;
          finishRepeatCount = 0;
        }
        if (finishRepeatCount >= 2) {
          await appendRunStep(db, {
            runId,
            seq: stepSeq++,
            type: 'message',
            resultJson: { event: 'finish_repeat_forced', count: finishRepeatCount },
          });
          await finishRun(finalOutput, 'finish_repeat_forced');
          return;
        }

        const validation = await validateOutput(finalOutput, 'finish', userPayload);
        if (validation.decision === 'revise' && run.kind !== 'subagent') {
          appendSystemNoteOnce(
            `Validation requested changes: ${validation.feedback || 'Improve clarity and correctness.'}`
          );
          await appendRunStep(db, {
            runId,
            seq: stepSeq++,
            type: 'message',
            resultJson: {
              event: 'validation_feedback',
              feedback: validation.feedback || 'Improve clarity and correctness.',
              retry: validation.retry,
            },
          });
          await appendRunStep(db, {
            runId,
            seq: stepSeq++,
            type: 'message',
            resultJson: {
              event: 'finish_blocked',
              reason: 'validation_revise',
              feedback: validation.feedback || 'Improve clarity and correctness.',
              retry: validation.retry,
            },
          });
          if (validation.retry) {
            finishValidationRetryCount += 1;
            if (finishValidationRetryCount < 2) {
              limitationRequired = false;
              limitationReason = null;
              continue;
            }
            await appendRunStep(db, {
              runId,
              seq: stepSeq++,
              type: 'message',
              resultJson: { event: 'validation_retry_exhausted', count: finishValidationRetryCount },
            });
            await finishRun(finalOutput, 'validation_retry_exhausted');
            return;
          }
          await appendRunStep(db, {
            runId,
            seq: stepSeq++,
            type: 'message',
            resultJson: { event: 'validation_override_finish' },
          });
          await finishRun(finalOutput, 'validation_override');
          return;
        }

        await finishRun(finalOutput, 'finish');
        return;
      }

      if (command.type === 'sleep') {
        actionCount += 1;
        rationaleReady = false;
        forceActionNext = false;
        actionViolationCount = 0;
        consecutiveNotes = 0;
        if (run.kind === 'coordinator') {
          if (runState.queue.length > 0) {
            appendSystemNoteOnce(
              'Cannot sleep while the coordinator queue is non-empty. Process or shift queue items first.'
            );
            if (await recordIterationAndCheck('blocked:sleep_queue_not_empty', false)) {
              return;
            }
            continue;
          }
          if (activeSubagentCount < 1) {
            appendSystemNoteOnce(
              'Cannot sleep without any running subagents. Spawn subagents or continue processing.'
            );
            if (await recordIterationAndCheck('blocked:sleep_no_subagents', false)) {
              return;
            }
            continue;
          }
        } else if (run.kind === 'subagent') {
          if (!runState.waitingForParent) {
            appendSystemNoteOnce(
              'Subagents may only sleep when waiting for a parent reply (waitingForParent=true).'
            );
            if (await recordIterationAndCheck('blocked:sleep_not_waiting_for_parent', false)) {
              return;
            }
            continue;
          }
        }
        if (!command.wakeAt && typeof command.delaySeconds !== 'number' && !command.cron) {
          appendSystemNoteOnce('sleep requires wakeAt, delaySeconds, or cron.');
          if (await recordIterationAndCheck('blocked:sleep_missing_time', false)) {
            return;
          }
          continue;
        }
        if (run.kind === 'subagent' && !runState.waitingForParent) {
          appendSystemNoteOnce(
            'Subagents may only sleep when waitingForParent=true. Otherwise continue or request_parent.'
          );
          if (await recordIterationAndCheck('blocked:sleep_not_waiting', false)) {
            return;
          }
          continue;
        }
        const wakeAtDate = computeWakeAt(command.wakeAt, command.delaySeconds);
        await appendRunStep(db, {
          runId,
          seq: stepSeq++,
          type: 'message',
          resultJson: {
            event: 'sleep',
            reason: command.reason ?? null,
            wakeAt: wakeAtDate ? wakeAtDate.toISOString() : command.wakeAt ?? null,
            delaySeconds: command.delaySeconds ?? null,
            cron: command.cron ?? null,
          },
        });
        await db
          .update(runs)
          .set({
            status: 'waiting',
            wakeAt: wakeAtDate ?? null,
            wakeReason: command.reason ?? null,
            updatedAt: new Date(),
          })
          .where(eq(runs.id, runId));
        if (command.cron) {
          await db.insert(triggers).values({
            agentId,
            type: 'cron',
            specJson: { cron: command.cron, runId } as any,
            nextFireAt: new Date(),
            enabled: true,
            createdAt: new Date(),
          });
        } else {
          if (wakeAtDate) {
            await db.insert(triggers).values({
              agentId,
              type: 'run_wake',
              specJson: { runId } as any,
              nextFireAt: wakeAtDate,
              enabled: true,
              createdAt: new Date(),
            });
          } else {
            logger.warn({ runId }, 'Sleep called without wakeAt or delaySeconds');
          }
        }
        logger.info('Run set to waiting', { runId });
        return;
      }

      if (command.type === 'spawn_subagent' || command.type === 'spawn_subagents') {
        actionCount += 1;
        rationaleReady = false;
        forceActionNext = false;
        actionViolationCount = 0;
        consecutiveNotes = 0;
        const rawSubagents =
          command.type === 'spawn_subagent' ? [command.subagent] : command.subagents;
        if (!Array.isArray(rawSubagents) || rawSubagents.length === 0) {
          appendSystemNoteOnce('spawn_subagent(s) requires at least one subagent spec.');
          if (await recordIterationAndCheck('blocked:spawn_missing_spec', false)) {
            return;
          }
          continue;
        }
        const missingTask = rawSubagents.some(
          (sub) => !sub || typeof sub.task !== 'string' || !sub.task.trim()
        );
        if (missingTask) {
          appendSystemNoteOnce('Each subagent spec must include a non-empty "task" string.');
          if (await recordIterationAndCheck('blocked:spawn_missing_task', false)) {
            return;
          }
          continue;
        }
        if (run.kind === 'subagent') {
          const allowSubagents = Boolean((run.inputJson as any)?.allowSubagents);
          const agentLevel =
            run.kind === 'subagent' ? ((run.inputJson as any)?.agentLevel ?? 1) : 0;
          if (!allowSubagents || agentLevel >= 2) {
            appendSystemNoteOnce(
              'Subagent spawning blocked: allowSubagents=false or max depth reached. Request the parent instead.'
            );
            if (await recordIterationAndCheck('blocked:subagent_spawn_not_allowed', false)) {
              return;
            }
            continue;
          }
        }
        if (runState.queue.length === 0) {
          const seededQueue = rawSubagents.map((sub) => sub.task).filter(Boolean);
          if (seededQueue.length > 0) {
            const nextState: RunState = { ...runState, queue: seededQueue };
            await persistRunState(nextState);
            await appendRunStep(db, {
              runId,
              seq: stepSeq++,
              type: 'message',
              resultJson: { event: 'spawn_queue_seeded', count: seededQueue.length },
            });
          } else {
            appendSystemNoteOnce(
              'Spawn blocked: coordinator must add tasks to state.queue via queue_op before spawning subagents.'
            );
            await appendRunStep(db, {
              runId,
              seq: stepSeq++,
              type: 'message',
              resultJson: { event: 'spawn_blocked', reason: 'empty_queue' },
            });
            if (await recordIterationAndCheck('blocked:spawn_empty_queue', false)) {
              return;
            }
            continue;
          }
        }
        const agentLevel =
          run.kind === 'subagent' ? ((run.inputJson as any)?.agentLevel ?? 1) : 0;
        if (agentLevel >= 2) {
          await appendRunStep(db, {
            runId,
            seq: stepSeq++,
            type: 'message',
            resultJson: {
              event: 'spawn_blocked',
              reason: 'max_agent_depth',
              agentLevel,
            },
          });
          appendSystemNoteOnce(
            'Subagent spawning blocked at max depth (agentLevel >= 2). Continue without delegation.'
          );
          continue;
        }
        const subagents = rawSubagents;
        const spawnAttemptSignature = stableStringify(
          subagents.map((sub) => ({
            profile: sub?.profile ?? null,
            task: sub?.task ?? null,
            tools: Array.isArray(sub?.tools) ? sub?.tools : [],
            context: sub?.context ?? [],
            agentLevel: sub?.agentLevel ?? null,
          }))
        );
        await appendRunStep(db, {
          runId,
          seq: stepSeq++,
          type: 'message',
          resultJson: {
            event: 'spawn_attempt',
            signature: spawnAttemptSignature,
            count: subagents.length,
          },
        });
        const created: Array<{ runId: string; task: string; profile?: string | null }> = [];
        const specs = subagents.map((sub) => ({
          profile: sub.profile ?? null,
          task: sub.task,
          tools: Array.isArray(sub.tools) ? sub.tools : [],
          context: sub.context ?? [],
          agentLevel: sub.agentLevel ?? null,
        }));
        let blockedAll = true;
        for (const sub of subagents) {
          const requestedLevel =
            typeof sub.agentLevel === 'number' ? Math.floor(sub.agentLevel) : agentLevel + 1;
          const childAgentLevel = Math.max(agentLevel + 1, Math.min(2, requestedLevel));
          const spawnSignature = `spawn:${stableStringify({
            profile: sub.profile ?? null,
            task: sub.task,
            tools: Array.isArray(sub.tools) ? sub.tools : [],
            context: sub.context ?? [],
            agentLevel: childAgentLevel,
          })}`;
          const spawnCount = (repeatedSpawnCounts.get(spawnSignature) ?? 0) + 1;
          repeatedSpawnCounts.set(spawnSignature, spawnCount);
          if (spawnCount > 1 || priorSpawnSignatures.has(spawnSignature)) {
            await appendRunStep(db, {
              runId,
              seq: stepSeq++,
              type: 'message',
              resultJson: { event: 'loop_detected', kind: 'spawn', task: sub.task },
            });
            continue;
          }
          blockedAll = false;
          const childRunId = randomUUID();
          const tools = Array.isArray(sub.tools) ? sub.tools : [];
          const normalizedContext = normalizeContextItems(sub.context ?? []);
          const enrichedContext = ensureSubagentContext(normalizedContext, {
            userRequest: (run.inputText ?? '').trim(),
            toolName: tools.join(', ') || undefined,
          });
          await db.insert(runs).values({
            id: childRunId,
            tenantId,
            agentId,
            userId: run.userId,
            channelId: run.channelId,
            contextId: run.contextId ?? null,
            parentRunId: runId,
            rootRunId: run.rootRunId ?? runId,
            kind: 'subagent',
            profile: sub.profile ?? null,
            inputText: sub.task,
            inputJson: {
              profile: sub.profile ?? null,
              context: enrichedContext,
              agentLevel: childAgentLevel,
              state: { queue: [], inbox: [] },
            },
            allowedTools: tools,
            outputText: '',
            status: 'pending',
          });

          await enqueueRun({
            type: 'run',
            runId: childRunId,
            tenantId,
            agentId,
          });

          created.push({ runId: childRunId, task: sub.task, profile: sub.profile ?? null });
        }

        if (blockedAll) {
          blockedSpawnCount += 1;
          if (spawnAttemptSignature === lastSpawnSignature) {
            appendSystemNoteOnce(
              'Repeated spawn request detected. Modify the task/queue or ask the user for clarification instead of retrying the same spawn.'
            );
          }
          lastSpawnSignature = spawnAttemptSignature;
          const message =
            'I already tried delegating this and it did not help, so I will stop spawning subagents and handle it directly.';
          await appendRunStep(db, {
            runId,
            seq: stepSeq++,
            type: 'message',
            resultJson: { event: 'spawn_blocked', reason: 'repeat_spawn', blockedSpawnCount },
          });
          if (blockedSpawnCount >= 2) {
            if (run.kind === 'subagent') {
              await db
                .update(runs)
                .set({ outputText: message, status: 'completed', updatedAt: new Date() })
                .where(eq(runs.id, runId));
              await appendRunStep(db, {
                runId,
                seq: stepSeq++,
                type: 'finish',
                resultJson: { output: message, reason: 'repeat_spawn' },
              });
              if (run.parentRunId) {
        await wakeParentRun(db, run.parentRunId, tenantId, agentId);
              }
              return;
            }
            const userMessage =
              `${message} I need a bit more detail to delegate properly. ` +
              'Could you clarify the location and dates you want me to check?';
            await sendRunMessage({
              db,
              userId: run.userId,
              channelId: run.channelId,
              contextId: run.contextId ?? null,
              content: userMessage,
              logger,
              runId,
              runKind: run.kind ?? 'coordinator',
            });
            await db
              .update(runs)
              .set({ outputText: userMessage, status: 'completed', updatedAt: new Date() })
              .where(eq(runs.id, runId));
            await appendRunStep(db, {
              runId,
              seq: stepSeq++,
              type: 'finish',
              resultJson: { output: userMessage, reason: 'repeat_spawn' },
            });
            return;
          }
          continue;
        }
        lastSpawnSignature = spawnAttemptSignature;

        await appendRunStep(db, {
          runId,
          seq: stepSeq++,
          type: 'message',
          resultJson: { event: 'spawn_subagents', subagents: created, specs },
        });

        if (created.length > 0) {
          await db
            .update(runs)
            .set({ status: 'waiting', wakeAt: new Date(Date.now() + 30000), wakeReason: 'subagent_watchdog', updatedAt: new Date() })
            .where(eq(runs.id, runId));
          await enqueueRunWake(
            {
              type: 'run',
              runId,
              tenantId,
              agentId,
            },
            30000
          );
          await appendRunStep(db, {
            runId,
            seq: stepSeq++,
            type: 'message',
            resultJson: { event: 'parent_wake_scheduled', delaySeconds: 30 },
          });
          logger.info('Run waiting for subagents', { runId, count: created.length });
          return;
        }
      }

      if (run.kind === 'coordinator') {
        const failedSubagents = await loadFailedSubagents(db, runId);
        if (failedSubagents.length > 0) {
          const fallbackPrompt = buildSubagentFailureFallback(failedSubagents);
          await db
            .update(runs)
            .set({ status: 'running', updatedAt: new Date() })
            .where(eq(runs.id, runId));
          await appendRunStep(db, {
            runId,
            seq: stepSeq++,
            type: 'message',
            resultJson: { event: 'subagent_failure_fallback', detail: fallbackPrompt },
          });

          const fallbackCommand: RunCommand = {
            type: 'send_message',
            message: fallbackPrompt,
          };

          const message = fallbackCommand.message?.trim();
          if (message) {
            await sendRunMessage({
              db,
              userId: run.userId,
              channelId: run.channelId,
              contextId: run.contextId ?? null,
              content: message,
              logger,
              runId,
              runKind: run.kind ?? 'coordinator',
            });
            await db
              .update(runs)
              .set({ outputText: message, status: 'completed', updatedAt: new Date() })
              .where(eq(runs.id, runId));
            await appendRunStep(db, {
              runId,
              seq: stepSeq++,
              type: 'finish',
              resultJson: { output: message, reason: 'subagent_failed' },
            });
            return;
          }
        }
      }
    }

    const finalOutput = outputText.trim() || lastAssistantMessage.trim();
    const rescueMessage = finalOutput || fallbackMessage;
    await finishRun(rescueMessage, 'max_iterations');
    logger.info('Run completed after max iterations', { runId });
    return;
  } catch (err) {
    logger.error('Run failed', { runId, err });
    await db.update(runs).set({ status: 'failed', updatedAt: new Date() }).where(eq(runs.id, runId));

    if (run.kind !== 'subagent') {
      try {
        const message = lastToolError?.error
          ? `Sorry, something went wrong while handling that request. Error: ${lastToolError.error}`
          : 'Sorry, something went wrong while handling that request.';
        await sendRunMessage({
          db,
          userId: run.userId,
          channelId: run.channelId,
          contextId: run.contextId ?? null,
          content: message,
          logger,
          runId,
          runKind: run.kind ?? 'coordinator',
        });
      } catch (sendErr) {
        logger.error({ runId, err: sendErr }, 'Failed to send error message');
      }
    }

    if (run.parentRunId) {
      const [parentStep] = await db
        .select()
        .from(runSteps)
        .where(eq(runSteps.runId, run.parentRunId))
        .orderBy(desc(runSteps.seq))
        .limit(1);
      const nextSeq = parentStep ? parentStep.seq + 1 : 0;

      await appendRunStep(db, {
        runId: run.parentRunId,
        seq: nextSeq,
        type: 'message',
        resultJson: {
          event: 'subagent_failed',
          subagentRunId: runId,
          error: lastToolError?.error ?? (err instanceof Error ? err.message : String(err)),
        },
      });

      await wakeParentRun(db, run.parentRunId, tenantId, agentId);
    }
    throw err;
  }
}

async function appendRunStep(
  db: ReturnType<typeof getDb>,
  data: {
    runId: string;
    seq: number;
    type: string;
    toolName?: string;
    argsJson?: Record<string, unknown>;
    resultJson?: Record<string, unknown>;
    status?: string;
  }
) {
  await db.insert(runSteps).values({
    runId: data.runId,
    seq: data.seq,
    type: data.type,
    toolName: data.toolName,
    argsJson: data.argsJson,
    resultJson: data.resultJson,
    status: data.status ?? 'completed',
    idempotencyKey: nanoid(),
  });
}

interface ToolCallContext {
  runId: string;
  tenantId: string;
  agentId: string;
  baseSeq: number;
  toolRegistry: ToolRegistry;
  policyEngine: PolicyEngine;
  db: ReturnType<typeof getDb>;
  logger: Logger;
  toolConfigMap: Map<string, Record<string, unknown>>;
  run: typeof runs.$inferSelect;
}

async function executeToolCall(toolCall: ToolCall, ctx: ToolCallContext): Promise<ToolResult> {
  const {
    runId,
    tenantId,
    agentId,
    baseSeq,
    toolRegistry,
    policyEngine,
    db,
    logger,
    toolConfigMap,
    run,
  } = ctx;

  const callStepKey = `${runId}:call:${toolCall.id}`;
  await db.insert(runSteps).values({
    runId,
    seq: baseSeq,
    type: 'tool_call',
    toolName: toolCall.name,
    argsJson: toolCall.args,
    status: 'completed',
    idempotencyKey: callStepKey,
  });

  const parsedName = parseToolCommandName(toolCall.name);
  if (!parsedName) {
    const fallbackTool = toolRegistry.getTool(toolCall.name);
    if (fallbackTool && fallbackTool.commands.length === 1) {
      const onlyCommand = fallbackTool.commands[0]?.name;
      if (onlyCommand) {
        return await executeToolCall(
          { ...toolCall, name: `${toolCall.name}.${onlyCommand}` },
          ctx
        );
      }
    }
    const result: ToolResult = {
      id: toolCall.id,
      success: false,
      error: 'Invalid tool name',
    };
    await db.insert(runSteps).values({
      runId,
      seq: baseSeq + 1,
      type: 'tool_result',
      toolName: toolCall.name,
      resultJson: result,
      status: 'failed',
      idempotencyKey: `${runId}:result:${toolCall.id}`,
    });
    return result;
  }

  const { toolName, commandName } = parsedName;

  const toolDef = toolRegistry.getTool(toolName);
  if (!toolDef) {
    const result: ToolResult = {
      id: toolCall.id,
      success: false,
      error: 'Tool not found',
    };
    await db.insert(runSteps).values({
      runId,
      seq: baseSeq + 1,
      type: 'tool_result',
      toolName: toolCall.name,
      resultJson: result,
      status: 'failed',
      idempotencyKey: `${runId}:result:${toolCall.id}`,
    });
    return result;
  }

  const commandDef = toolRegistry.getCommand(toolName, commandName);
  if (!commandDef) {
    const result: ToolResult = {
      id: toolCall.id,
      success: false,
      error: 'Tool command not found',
    };
    await db.insert(runSteps).values({
      runId,
      seq: baseSeq + 1,
      type: 'tool_result',
      toolName: toolCall.name,
      resultJson: result,
      status: 'failed',
      idempotencyKey: `${runId}:result:${toolCall.id}`,
    });
    return result;
  }

  const decision = await policyEngine.decideToolCall(
    {
      tenantId,
      agentId,
      toolName,
      commandName,
      args: toolCall.args,
      policyProfile: 'default',
    },
    toolDef
  );

  if (decision === 'deny') {
    const result: ToolResult = {
      id: toolCall.id,
      success: false,
      error: 'Denied by policy',
    };
    await db.insert(runSteps).values({
      runId,
      seq: baseSeq + 1,
      type: 'tool_result',
      toolName: toolCall.name,
      resultJson: result,
      status: 'failed',
      idempotencyKey: `${runId}:result:${toolCall.id}`,
    });
    return result;
  }

  try {
    const toolConfig = toolConfigMap.get(toolName) ?? {};
    const resultPayload = await commandDef.handler(
      {
        tenantId,
        agentId,
        runId,
        db,
        logger,
        toolResolver: toolRegistry,
        userId: run.userId,
        channelId: run.channelId,
        toolConfig,
      },
      toolCall.args
    );

    const payloadSuccess =
      typeof (resultPayload as { success?: unknown }).success === 'boolean'
        ? Boolean((resultPayload as { success?: boolean }).success)
        : true;

    const result: ToolResult = {
      id: toolCall.id,
      success: payloadSuccess,
      result: resultPayload,
      error: payloadSuccess ? undefined : String((resultPayload as { error?: unknown }).error ?? ''),
    };

    await db.insert(runSteps).values({
      runId,
      seq: baseSeq + 1,
      type: 'tool_result',
      toolName: toolCall.name,
      resultJson: result,
      status: 'completed',
      idempotencyKey: `${runId}:result:${toolCall.id}`,
    });

    return result;
  } catch (err) {
    logger.error('Tool execution failed', { toolName: toolCall.name, err });
    const isZod = err instanceof ZodError;
    const result: ToolResult = {
      id: toolCall.id,
      success: false,
      error: isZod ? 'invalid_args' : String(err),
      result: isZod
        ? {
            error_code: 'invalid_args',
            error_message: 'Tool arguments failed validation.',
            details: err.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
              code: issue.code,
            })),
          }
        : undefined,
    };
    await db.insert(runSteps).values({
      runId,
      seq: baseSeq + 1,
      type: 'tool_result',
      toolName: toolCall.name,
      resultJson: result,
      status: 'failed',
      idempotencyKey: `${runId}:result:${toolCall.id}`,
    });
    return result;
  }
}

function parseRunCommand(responseText: string): (RunCommand | SpawnCommand) | null {
  try {
    const parsed = JSON.parse(responseText) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    if (typeof parsed.type === 'string') {
      if (
        parsed.type === 'tool_call' ||
        parsed.type === 'send_message' ||
        parsed.type === 'deliver_subagent_output' ||
        parsed.type === 'request_parent' ||
        parsed.type === 'reply_subagent' ||
        parsed.type === 'retry_subagent' ||
        parsed.type === 'queue_op' ||
        parsed.type === 'set_output' ||
        parsed.type === 'finish' ||
        parsed.type === 'decision' ||
        parsed.type === 'note' ||
        parsed.type === 'set_run_limits' ||
        parsed.type === 'spawn_subagent' ||
        parsed.type === 'spawn_subagents' ||
        parsed.type === 'sleep'
      ) {
        return parsed as RunCommand | SpawnCommand;
      }

      const toolName = parseToolCommandName(parsed.type);
      if (toolName) {
        return {
          type: 'tool_call',
          name: parsed.type,
          args: (parsed.args as Record<string, unknown>) ?? {},
        };
      }
    }

    if (typeof parsed.name === 'string') {
      const toolName = parseToolCommandName(parsed.name);
      if (toolName) {
        return {
          type: 'tool_call',
          name: parsed.name,
          args: (parsed.args as Record<string, unknown>) ?? {},
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}

function applyOutputUpdate(
  currentOutput: string,
  output: string | undefined,
  mode: 'replace' | 'append' | undefined
) {
  if (!output) {
    return currentOutput;
  }
  if ((mode ?? 'replace') === 'append') {
    const separator = currentOutput && !currentOutput.endsWith('\n') ? '\n' : '';
    return `${currentOutput}${separator}${output}`.trim();
  }

  return output.trim();
}

function trimTranscript(
  transcript: TranscriptEntry[],
  maxEntries: number,
  maxTokens: number
) {
  const limited = transcript.slice(-maxEntries);
  let totalTokens = 0;
  const result: TranscriptEntry[] = [];
  for (let i = limited.length - 1; i >= 0; i -= 1) {
    const entry = limited[i];
    const tokens = estimateTokens(entry);
    if (totalTokens + tokens > maxTokens) {
      break;
    }
    totalTokens += tokens;
    result.unshift(entry);
  }
  return result;
}

function estimateTokens(entry: TranscriptEntry) {
  const raw = JSON.stringify(entry);
  return Math.max(1, Math.ceil(raw.length / 4));
}

function truncateForLog(value: unknown, limit = 2000) {
  const text = JSON.stringify(value);
  if (text.length <= limit) return value;
  return `${text.slice(0, limit)}…(truncated)`;
}

function normalizeRunState(state: unknown): RunState {
  const fallback: RunState = {
    queue: [],
    inbox: [],
    waitingForParent: false,
    autoRecoverySpawned: false,
    lastRequestParentMessage: '',
    requestParentRepeatCount: 0,
  };
  if (!state || typeof state !== 'object') {
    return fallback;
  }
  const record = state as Record<string, unknown>;
  const queue = Array.isArray(record.queue)
    ? record.queue.filter((item) => typeof item === 'string')
    : [];
  const inbox = Array.isArray(record.inbox)
    ? record.inbox
        .filter(
          (item) =>
            item &&
            typeof item === 'object' &&
            typeof (item as Record<string, unknown>).message === 'string'
        )
        .map((item) => {
          const entry = item as Record<string, unknown>;
          return {
            fromRunId: typeof entry.fromRunId === 'string' ? entry.fromRunId : 'unknown',
            message: String(entry.message ?? ''),
            at: typeof entry.at === 'string' ? entry.at : new Date().toISOString(),
          };
        })
    : [];
  const waitingForParent = Boolean(record.waitingForParent);
  const autoRecoverySpawned = Boolean(record.autoRecoverySpawned);
  const lastRequestParentMessage =
    typeof record.lastRequestParentMessage === 'string' ? record.lastRequestParentMessage : '';
  const requestParentRepeatCount =
    typeof record.requestParentRepeatCount === 'number' ? record.requestParentRepeatCount : 0;
  return {
    queue,
    inbox,
    waitingForParent,
    autoRecoverySpawned,
    lastRequestParentMessage,
    requestParentRepeatCount,
  };
}

function mergeRunInputJson(
  inputJson: unknown,
  state: RunState
): Record<string, unknown> {
  const base =
    inputJson && typeof inputJson === 'object'
      ? ({ ...(inputJson as Record<string, unknown>) } as Record<string, unknown>)
      : {};
  base.state = state;
  return base;
}

function computeWakeAt(wakeAt?: string, delaySeconds?: number) {
  if (typeof delaySeconds === 'number' && Number.isFinite(delaySeconds)) {
    return new Date(Date.now() + Math.max(0, Math.floor(delaySeconds * 1000)));
  }
  if (wakeAt) {
    const parsed = Date.parse(wakeAt);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed);
    }
  }
  return null;
}

async function loadCoreMemories(db: ReturnType<typeof getDb>, userId: string) {
  const rows = await db
    .select()
    .from(memoryItems)
    .where(and(eq(memoryItems.userId, userId), eq(memoryItems.archived, false)));

  const byLevel = new Map<number, typeof rows>();
  for (const item of rows) {
    const list = byLevel.get(item.level) ?? [];
    list.push(item);
    byLevel.set(item.level, list);
  }

  for (const list of byLevel.values()) {
    list.sort(
      (a, b) => (b.lastSeenAt?.getTime?.() ?? 0) - (a.lastSeenAt?.getTime?.() ?? 0)
    );
  }

  const selected: typeof rows = [];
  for (const level of [0, 1, 2, 3, 4, 5]) {
    const list = byLevel.get(level) ?? [];
    selected.push(...list.slice(0, 5));
  }

  return selected.map((item) => ({
    id: item.id,
    level: item.level,
    module: item.module,
    key: item.key,
    value: truncateMemoryValue(item.value, item.level),
    confidence: item.confidence,
    lastSeenAt: item.lastSeenAt,
    contextId: item.contextId,
    pinned: item.pinned,
  }));
}

async function loadPriorSpawnSignatures(db: ReturnType<typeof getDb>, runId: string) {
  const rows = await db
    .select({ resultJson: runSteps.resultJson })
    .from(runSteps)
    .where(and(eq(runSteps.runId, runId), eq(runSteps.type, 'message')));

  const signatures = new Set<string>();
  for (const row of rows) {
    const result = row.resultJson as { event?: string; specs?: any[]; subagents?: any[] } | null;
    if (!result || result.event !== 'spawn_subagents') continue;
    const specs = Array.isArray(result.specs) ? result.specs : [];
    if (specs.length > 0) {
      for (const spec of specs) {
        signatures.add(`spawn:${stableStringify(spec)}`);
      }
      continue;
    }
    const subs = Array.isArray(result.subagents) ? result.subagents : [];
    for (const sub of subs) {
      signatures.add(
        `spawn:${stableStringify({
          profile: sub.profile ?? null,
          task: sub.task,
          tools: [],
          context: [],
        })}`
      );
    }
  }
  return signatures;
}

function truncateMemoryValue(value: string, level: number) {
  const maxCharsByLevel: Record<number, number> = {
    0: 160,
    1: 160,
    2: 140,
    3: 120,
    4: 100,
    5: 90,
  };
  const maxChars = maxCharsByLevel[level] ?? 120;
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

function stableStringify(value: unknown) {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(',')}}`;
}

async function wakeParentRun(
  db: ReturnType<typeof getDb>,
  parentRunId: string,
  tenantId: string,
  agentId: string
) {
  await db
    .update(runs)
    .set({ status: 'pending', wakeAt: null, wakeReason: null, updatedAt: new Date() })
    .where(eq(runs.id, parentRunId));

  await enqueueRunWake({
    type: 'run',
    runId: parentRunId,
    tenantId,
    agentId,
  });
}


function buildToolPrompt(tools: ToolDef[], kind: string) {
  if (kind === 'coordinator') {
    const lines: string[] = [];
    lines.push('All tools (short form):');
    for (const tool of tools) {
      const commands = tool.commands.map((command) => `${tool.name}.${command.name}`).join(', ');
      lines.push(`- ${tool.name}: ${tool.shortDescription} | commands: ${commands}`);
    }
    return lines.join('\n');
  }

  const pinned = tools.filter((tool) => tool.pinned);
  const important = tools.filter((tool) => !tool.pinned && tool.important);

  const lines: string[] = [];

  if (pinned.length > 0) {
    lines.push('Pinned tools (all commands available):');
    for (const tool of pinned) {
      const commandNames = tool.commands.map((command) => command.name).join(', ') || '(none)';
      lines.push(`- ${tool.name}: ${commandNames}`);
    }
  }

  if (important.length > 0) {
    lines.push('Important tools:');
    for (const tool of important) {
      lines.push(`- ${tool.name}: ${tool.shortDescription}`);
    }
  }

  if (lines.length === 0) {
    lines.push('No tools are pinned or marked important.');
  }

  return lines.join('\n');
}

async function sendRunMessage({
  db,
  userId,
  channelId,
  contextId,
  content,
  logger,
  runId,
  runKind,
}: {
  db: ReturnType<typeof getDb>;
  userId: string;
  channelId: string;
  contextId: string | null;
  content: string;
  logger: Logger;
  runId: string;
  runKind: string;
}): Promise<boolean> {
  const [channel] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
  if (!channel || channel.userId !== userId) {
    logger.warn({ channelId, userId }, 'Channel not found for run message');
    return false;
  }

  let outboundId: string | null = null;
  try {
    const [outbound] = await db
      .insert(messages)
      .values({
        id: randomUUID(),
        userId,
        channelId,
        contextId: contextId ?? null,
        content,
        direction: 'outbound',
        deliveryStatus: channel.type === 'web' ? 'delivered' : 'pending',
        deliveredAt: channel.type === 'web' ? new Date() : null,
        metadata: JSON.stringify({
          source: 'run',
          runId,
          kind: runKind,
        }),
      })
      .returning();
    outboundId = outbound?.id ?? null;
  } catch (err) {
    logger.error({ channelId, err }, 'Failed to insert outbound run message');
    return false;
  }

  if (!outboundId) {
    logger.error({ channelId }, 'Failed to create outbound run message');
    return false;
  }

  if (channel.type === 'discord') {
    let discordUserId: string | undefined;

    const configValue = channel.config as { discordUserId?: string } | null;
    if (configValue?.discordUserId) {
      discordUserId = configValue.discordUserId;
    }

    if (!discordUserId) {
      logger.warn({ channelId }, 'Discord user ID missing; cannot send DM');
      return false;
    }

    await enqueueDelivery({
      type: 'delivery',
      provider: 'discord',
      messageId: outboundId,
      payload: {
        discordUserId,
        content,
      },
    });
  }

  logger.info({ channelId, messageId: outboundId }, 'Run message sent');
  return true;
}

async function loadConversation(
  db: ReturnType<typeof getDb>,
  channelId: string,
  contextId: string | null,
  limit?: number
) {
  const query = db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.channelId, channelId),
        contextId ? eq(messages.contextId, contextId) : eq(messages.contextId, null)
      )
    )
    .orderBy(messages.createdAt);

  const rows = limit ? await query.limit(limit) : await query;

  return rows.map((row) => ({
    role: row.direction === 'inbound' ? 'user' : 'assistant',
    content: row.content,
  }));
}

async function loadSubagentResults(db: ReturnType<typeof getDb>, runId: string) {
  const rows = await db
    .select({
      id: runs.id,
      status: runs.status,
      outputText: runs.outputText,
      profile: runs.profile,
      inputText: runs.inputText,
      updatedAt: runs.updatedAt,
    })
    .from(runs)
    .where(eq(runs.parentRunId, runId))
    .orderBy(runs.updatedAt);

  return rows.map((row) => ({
    runId: row.id,
    status: row.status,
    profile: row.profile,
    task: row.inputText,
    output: row.outputText,
    updatedAt: row.updatedAt,
  }));
}

async function loadFailedSubagents(db: ReturnType<typeof getDb>, runId: string) {
  const rows = await db
    .select({
      id: runs.id,
      status: runs.status,
      outputText: runs.outputText,
      profile: runs.profile,
      inputText: runs.inputText,
      updatedAt: runs.updatedAt,
    })
    .from(runs)
    .where(and(eq(runs.parentRunId, runId), eq(runs.status, 'failed')))
    .orderBy(desc(runs.updatedAt));

  return rows.map((row) => ({
    runId: row.id,
    profile: row.profile,
    task: row.inputText,
    output: row.outputText,
  }));
}

function buildSubagentFailureFallback(
  failures: Array<{ runId: string; profile: string | null; task: string; output: string | null }>
) {
  const lines = failures.map(
    (item, index) =>
      `${index + 1}. ${item.profile ?? 'subagent'} failed on \"${item.task}\"${
        item.output ? `: ${item.output}` : ''
      }`
  );
  return `I tried to delegate parts of the request, but a subagent failed. Details:\\n${lines.join(
    '\\n'
  )}\\nWould you like me to try a different approach?`;
}
