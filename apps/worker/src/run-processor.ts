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
import { eq, and, desc } from 'drizzle-orm';
import { PolicyEngine } from '@clifford/policy';
import { ToolRegistry } from './tool-registry.js';
import { nanoid } from 'nanoid';
import { config } from './config.js';
import { decryptSecret } from './crypto.js';
import { callOpenAIWithFallback, type OpenAIMessage } from './openai-client.js';
import { enqueueDelivery, enqueueRun } from './queues.js';
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

  // Update status to running
  await db.update(runs).set({ status: 'running', updatedAt: new Date() }).where(eq(runs.id, runId));

  let stepSeq = 0;
  let lastToolError: { tool: string; error?: string } | null = null;
  const repeatedCallCounts = new Map<string, number>();
  const repeatedSpawnCounts = new Map<string, number>();
  let blockedSpawnCount = 0;

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
      ? enabledTools.filter((tool) => allowedToolSet.has(tool.name))
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

    const systemPrompt =
      'You are a task agent. You MUST respond with a single JSON object only. ' +
      'No prose, no markdown. The JSON must match one of these shapes:\n' +
      '1) {"type":"tool_call","name":"tool.command","args":{...}}\n' +
      '2) {"type":"send_message","message":"..."}\n' +
      '3) {"type":"set_output","output":"...","mode":"replace"|"append"}\n' +
      '4) {"type":"finish","output":"...","mode":"replace"|"append"}\n' +
      '5) {"type":"decision","content":"...","importance":"low"|"normal"|"high"}\n' +
      '6) {"type":"note","category":"requirements"|"plan"|"artifact"|"validation","content":"..."}\n' +
      '7) {"type":"set_run_limits","maxIterations":12,"reason":"..."}\n' +
      '8) {"type":"spawn_subagent","subagent":{"profile":"...","task":"...","tools":["..."],"context":[...]}}\n' +
      '9) {"type":"spawn_subagents","subagents":[{"profile":"...","task":"...","tools":["..."],"context":[...]}]}\n' +
      '10) {"type":"sleep","reason":"...","wakeAt":"ISO-8601","delaySeconds":123,"cron":"*/5 * * * *"}\n' +
      'DEFAULT: answer directly and finish in a single step when possible. ' +
      'Only use tool_call if it is necessary to answer correctly. ' +
      'Avoid multi-step iteration for simple questions. ' +
      'Preserve line breaks in message/output using \\n. ' +
      'If you are unsure how to answer or need capabilities, first call tools.list. ' +
      'If tools.list suggests a relevant tool, call tools.describe for that tool before replying. ' +
      'Do NOT respond with "I cannot" or "I do not have access" without checking tools first. ' +
      'Tool calls must use the full command name (tool.command), not just the tool name. ' +
      'Use send_message only to provide progress updates for long tasks. ' +
      'Use set_output when assembling a longer response over multiple steps. ' +
      'Use finish when the task is complete; the output will be sent to the user. ' +
      'Use decision to record brief coordinator reasoning/justifications; it is shown in the coordinator view but not sent to the user. ' +
      'Use note to record requirements, plan, artifacts, and validation summaries; it is shown in the task view. ' +
      'If you emit a plan note in a coordinator run, you MUST set_run_limits next. ' +
      'If required data is missing or a tool returns success:false, you MUST finish with a limitation statement and best-effort output. Do not keep iterating. ' +
      'Never claim a multi-day forecast unless the tool result includes daily[]. ' +
      'When unsure or planning multi-step work, emit a decision before taking actions. ' +
      'agentLevel indicates nesting depth: 0 = coordinator, 1 = subagent, 2 = subsubagent. ' +
      'If agentLevel >= 2, you MUST NOT spawn any subagents. ' +
      'Only spawn a subagent when it clearly reduces work or parallelizes distinct tasks; otherwise act directly. ' +
      'Avoid useless delegation; do not spawn a subagent just to ask the user a simple question. ' +
      'Subagents must NEVER message the user directly; they should finish with output for the coordinator. ' +
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
      'Process tasks using this internal loop, emitting structured notes so the task dialog shows your work:\n' +
      'Step 1: Identify the goal/target/output/role. Emit note(category="requirements").\n' +
      'Step 2: Hard constraints + success criteria. Emit note(category="requirements").\n' +
      'Step 3: Resources (tools/memories/context). Emit note(category="plan") summarizing what you will use.\n' +
      'Step 4: Micro-plan and delegation decision. Emit note(category="plan").\n' +
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
    const systemNoteCache = new Set<string>();
    const appendSystemNoteOnce = (content: string) => {
      if (systemNoteCache.has(content)) return false;
      systemNoteCache.add(content);
      transcript.push({ type: 'system_note', content });
      return true;
    };
    const hardCap = Math.max(1, config.runMaxIterationsHardCap);
    let runIterationLimit = Math.min(Math.max(1, config.runMaxIterations), hardCap);
    let runLimitsSet = false;
    let limitationRequired = false;
    let limitationReason: string | null = null;
    const recentIterations: Array<{
      hadToolCall: boolean;
      outputSnapshot: string;
      commandSignature: string | null;
    }> = [];
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

    const forceFinishIfStuck = async (iteration: number, reason: string) => {
      const hasToolCalls = transcript.some((entry) => entry.type === 'tool_call');
      const shouldForce =
        iteration >= Math.min(5, config.runMaxIterations - 1) &&
        !outputText &&
        !lastAssistantMessage &&
        !hasToolCalls;
      if (!shouldForce) return false;

      await finishRun(fallbackMessage, reason);
      logger.info('Run completed after planning stall', { runId, iteration, reason });
      return true;
    };

    const recordIterationAndCheck = async (commandSignature: string | null, hadToolCall: boolean) => {
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
      const budgetExceeded = iteration >= runIterationLimit;
      if (budgetExceeded) {
        const notice =
          'Budget reached. Reflect on progress; if stuck, finish with best-effort output and a brief explanation. Otherwise set_run_limits(maxIterations) with a higher limit (<= hard cap) and a brief reason.';
        appendSystemNoteOnce(notice);
      }
      const transcriptWindow = trimTranscript(transcript, config.runTranscriptLimit, config.runTranscriptTokenLimit);

      const subagentResults =
        run.kind === 'coordinator' ? await loadSubagentResults(db, runId) : [];

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

      if (
        run.kind === 'coordinator' &&
        noteCounts.plan > 0 &&
        !runLimitsSet &&
        iteration >= 2 &&
        command.type !== 'set_run_limits'
      ) {
        appendSystemNoteOnce('You must set_run_limits(maxIterations) now or you cannot proceed.');
        if (await recordIterationAndCheck('blocked:set_run_limits', false)) {
          return;
        }
        continue;
      }

      if (budgetExceeded && command.type !== 'set_run_limits' && command.type !== 'finish') {
        appendSystemNoteOnce(
          'Budget reached. Reflect on progress; if stuck, finish with best-effort output and a brief explanation. Otherwise set_run_limits(maxIterations) with a higher limit (<= hard cap) and a brief reason.'
        );
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
        const requested = Number(command.maxIterations);
        if (!Number.isFinite(requested) || requested <= 0) {
          appendSystemNoteOnce('set_run_limits requires maxIterations to be a positive number.');
          continue;
        }
        const clamped = Math.max(1, Math.min(hardCap, Math.floor(requested)));
        runIterationLimit = clamped;
        runLimitsSet = true;
        await appendRunStep(db, {
          runId,
          seq: stepSeq++,
          type: 'message',
          resultJson: { event: 'set_run_limits', maxIterations: clamped, reason: command.reason ?? null },
        });
        appendSystemNoteOnce(`Run limits set to ${clamped} iterations.`);
        if (await recordIterationAndCheck(`set_run_limits:${clamped}`, false)) {
          return;
        }
        continue;
      }

      if (command.type === 'tool_call') {
        if (noteCounts.requirements === 0 || noteCounts.plan === 0) {
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
        const message = command.message?.trim();
        if (!message) {
          throw new Error('send_message requires a non-empty message');
        }

        if (run.kind === 'subagent') {
          outputText = message;
          await appendRunStep(db, {
            runId,
            seq: stepSeq++,
            type: 'assistant_message',
            resultJson: { message },
          });
          await db
            .update(runs)
            .set({ outputText: message, status: 'completed', updatedAt: new Date() })
            .where(eq(runs.id, runId));
          await appendRunStep(db, {
            runId,
            seq: stepSeq++,
            type: 'finish',
            resultJson: { output: message, reason: 'subagent_message' },
          });
          if (run.parentRunId) {
            await wakeParentRun(db, run.parentRunId, tenantId, agentId);
          }
          logger.info('Subagent completed via send_message', { runId });
          return;
        }

        if (message === lastAssistantMessage) {
          await db
            .update(runs)
            .set({ outputText: outputText || message, status: 'completed', updatedAt: new Date() })
            .where(eq(runs.id, runId));
          await appendRunStep(db, {
            runId,
            seq: stepSeq++,
            type: 'finish',
            resultJson: { output: outputText || message },
          });
          logger.info('Run completed after duplicate send_message', { runId });
          return;
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
          await db
            .update(runs)
            .set({ outputText: message, status: 'completed', updatedAt: new Date() })
            .where(eq(runs.id, runId));
          await appendRunStep(db, {
            runId,
            seq: stepSeq++,
            type: 'finish',
            resultJson: { output: message },
          });
          logger.info('Run completed after direct send_message', { runId });
          return;
        }
        if (await recordIterationAndCheck('send_message', false)) {
          return;
        }
        continue;
      }

      if (command.type === 'set_output') {
        if (noteCounts.requirements === 0 || noteCounts.plan === 0) {
          appendSystemNoteOnce(
            'Before producing output, emit note(category="requirements") and note(category="plan").'
          );
          if (await forceFinishIfStuck(iteration, 'planning_required')) {
            return;
          }
          if (await recordIterationAndCheck('blocked:planning_required', false)) {
            return;
          }
          continue;
        }
        const nextOutput = applyOutputUpdate(outputText, command.output, command.mode);
        outputText = nextOutput;

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
        if (await recordIterationAndCheck('set_output', false)) {
          return;
        }
        continue;
      }

      if (command.type === 'decision') {
        const content = command.content?.trim();
        if (!content) {
          throw new Error('decision requires non-empty content');
        }
        await appendRunStep(db, {
          runId,
          seq: stepSeq++,
          type: 'decision',
          resultJson: { content, importance: command.importance ?? 'normal' },
        });
        transcript.push({ type: 'decision', content, importance: command.importance ?? 'normal' });
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
          throw new Error('note requires non-empty content');
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
        if (await forceFinishIfStuck(iteration, 'note_loop')) {
          return;
        }
        if (await recordIterationAndCheck(`note:${command.category}`, false)) {
          return;
        }
        continue;
      }

      if (command.type === 'finish') {
        if (noteCounts.requirements === 0 || noteCounts.plan === 0) {
          appendSystemNoteOnce(
            'Before finishing, emit note(category="requirements") and note(category="plan").'
          );
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

        await db
          .update(runs)
          .set({ outputText, status: 'completed', updatedAt: new Date() })
          .where(eq(runs.id, runId));

        await appendRunStep(db, {
          runId,
          seq: stepSeq++,
          type: 'finish',
          resultJson: { output: outputText },
        });

        const finalOutput = outputText.trim() || lastAssistantMessage.trim();
        if (!finalOutput) {
          throw new Error('Finish called without output or prior message');
        }

        if (run.kind !== 'subagent' && finalOutput !== lastAssistantMessage.trim()) {
          await sendRunMessage({
            db,
            userId: run.userId,
            channelId: run.channelId,
            contextId: run.contextId ?? null,
            content: finalOutput,
            logger,
            runId,
            runKind: run.kind ?? 'coordinator',
          });
        }

        logger.info('Run completed', { runId });
        if (run.parentRunId) {
          await wakeParentRun(db, run.parentRunId, tenantId, agentId);
        }
        return;
      }

      if (command.type === 'sleep') {
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
        const subagents = command.type === 'spawn_subagent' ? [command.subagent] : command.subagents;
        const created: Array<{ runId: string; task: string; profile?: string | null }> = [];
        const specs = subagents.map((sub) => ({
          profile: sub.profile ?? null,
          task: sub.task,
          tools: Array.isArray(sub.tools) ? sub.tools : [],
          context: sub.context ?? [],
        }));
        let blockedAll = true;
        for (const sub of subagents) {
          const spawnSignature = `spawn:${stableStringify({
            profile: sub.profile ?? null,
            task: sub.task,
            tools: Array.isArray(sub.tools) ? sub.tools : [],
            context: sub.context ?? [],
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
              context: sub.context ?? [],
              agentLevel: agentLevel + 1,
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
              resultJson: { output: message, reason: 'repeat_spawn' },
            });
            return;
          }
          continue;
        }

        await appendRunStep(db, {
          runId,
          seq: stepSeq++,
          type: 'message',
          resultJson: { event: 'spawn_subagents', subagents: created, specs },
        });

        if (created.length > 0) {
          await db
            .update(runs)
            .set({ status: 'waiting', updatedAt: new Date() })
            .where(eq(runs.id, runId));
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
    const result: ToolResult = {
      id: toolCall.id,
      success: false,
      error: String(err),
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

  await enqueueRun({
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
