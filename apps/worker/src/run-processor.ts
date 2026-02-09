import type { Job } from 'bullmq';
import type { Logger, RunJob, ToolCall, ToolResult, ToolDef } from '@clifford/sdk';
import {
  parseToolCommandName,
  commandSchema,
  commandJsonSchema,
  formatValidationError,
  type Command,
} from '@clifford/sdk';
import { canonicalize, repair } from './action-canonicalizer.js';
import { ProvenanceTracker } from './provenance-tracker.js';
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
  agents,
} from '@clifford/db';
import { eq, and, desc, inArray, isNull } from 'drizzle-orm';
import { PolicyEngine, createBudgetState, type BudgetState } from '@clifford/policy';
import { ToolRegistry } from './tool-registry.js';
import { nanoid } from 'nanoid';
import { config } from './config.js';
import { decryptSecret } from '@clifford/core';
import {
  callOpenAIWithFallback,
  callOpenAIStructuredWithFallback,
  supportsStructuredOutputs,
  type OpenAIMessage,
} from './openai-client.js';
import { ZodError } from 'zod';
import { enqueueDelivery, enqueueRun } from './queues.js';
import { randomUUID } from 'crypto';
import { ModelRouter, createRoutingConfig, type RoutingConfig } from './model-router.js';
import { classifyTask, type TaskType } from './task-classifier.js';
import { encodeUserPayload, buildSystemPromptMarkdown } from '@clifford/toon';
import { decideUserMessageCommit } from './message-commit-gate.js';

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
    }
  | {
      type: 'recover';
      reason: string;
      action?: 'retry' | 'finish' | 'ask_user';
      message?: string;
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
  | { type: 'recovery'; reason: string; action?: string }
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
  const repeatedResultCounts = new Map<string, number>();
  const repeatedSpawnCounts = new Map<string, number>();
  let blockedSpawnCount = 0;
  let hasCommittedUserMessage = false;
  let committedUserMessageHash: string | null = null;
  let committedUserMessageNormalized: string | null = null;

  try {
    // 2. Load agent plugins
    const plugins = await db.select().from(agentPlugins).where(eq(agentPlugins.agentId, agentId));

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
        pinned: setting?.pinned ?? (hasUserToolSettings ? false : (tool.pinned ?? false)),
        important: setting?.important ?? (hasUserToolSettings ? false : (tool.important ?? false)),
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

    // 6. Load routing configuration (from agent or user settings)
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
    const routingConfig: RoutingConfig | null =
      (agent?.routingConfig as RoutingConfig | null) ??
      (settings.routingConfig as RoutingConfig | null) ??
      null;

    // Create model router if routing config is available
    const modelRouter = routingConfig ? new ModelRouter(apiKey, routingConfig) : null;
    let currentTaskType: TaskType = 'plan';

    const toolDescriptions = buildToolPrompt(toolRegistry.getAllTools(), run.kind ?? 'coordinator');

    const systemPrompt = buildSystemPromptMarkdown(toolRegistry.getAllTools(), {
      runKind: run.kind ?? 'coordinator',
    });

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
      void appendRunStep(db, {
        runId,
        seq: stepSeq++,
        type: 'message',
        resultJson: { event: 'system_note', content },
      });
      return true;
    };
    const provenanceTracker = new ProvenanceTracker();

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
    const hasOutputKeyword = (text: string) =>
      /(output|result|return|provide|deliver|include|list|date|day|criteria|format|best)/i.test(
        text
      );
    const toolNames = toolRegistry.getAllTools().map((tool) => tool.name);
    const mentionsAnyTool = (text: string) =>
      toolNames.some((name) => name && text.toLowerCase().includes(name.toLowerCase()));
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
    const budgetState = createBudgetState({
      tokensLimit: config.runMaxTokens,
      timeLimitMs: config.runBudgetTimeLimitMs,
    });

    const validateOutput = async (candidate: string, reason: string, payload: unknown) => {
      if (!candidate.trim()) {
        return { decision: 'send' as const, feedback: '', retry: false };
      }
      if (validationAttempts >= 2) {
        return { decision: 'send' as const, feedback: '', retry: false };
      }
      if (candidate === lastValidatedOutput) {
        return { decision: 'send' as const, feedback: '', retry: false };
      }
      const validationSystemPrompt =
        'You are an output validator. Return only JSON: ' +
        '{"decision":"send"|"revise","feedback":"...","retry":true|false}. ' +
        'Use "revise" if the output is misleading, incomplete, or violates constraints. ' +
        'Use "revise" if the output contains numeric claims (ratings, scores, averages) without matching provenance data (no search/fetch for that topic). ' +
        'Use "retry": true only if another attempt is likely to improve the result. ' +
        'If the output is a failure/limitation message, decide whether to retry or send as-is.';
      const validationUserPrompt = JSON.stringify({
        reason,
        output: candidate,
        context: payload,
        provenance: provenanceTracker.getSummary(),
      });
      let responseText = '';
      try {
        const validationMessages: OpenAIMessage[] = [
          { role: 'system', content: validationSystemPrompt },
          { role: 'user', content: validationUserPrompt },
        ];
        budgetState.tokensUsed += estimateMessagesTokens(validationMessages);
        budgetState.timeUsedMs = Date.now() - runStartMs;
        responseText = await callOpenAIWithFallback(
          apiKey,
          model,
          fallbackModel,
          validationMessages,
          { temperature: 0 }
        );
        budgetState.tokensUsed += Math.max(1, Math.ceil(responseText.length / 4));
      } catch {
        return { decision: 'send' as const, feedback: '', retry: false };
      }
      try {
        const parsed = JSON.parse(responseText) as {
          decision?: 'send' | 'revise';
          feedback?: string;
          retry?: boolean;
        };
        const decision = parsed.decision === 'revise' ? 'revise' : 'send';
        const feedback = typeof parsed.feedback === 'string' ? parsed.feedback.trim() : '';
        const retry = Boolean(parsed.retry);
        validationAttempts += 1;
        lastValidatedOutput = candidate;
        lastValidationFeedback = feedback;
        return { decision, feedback, retry };
      } catch {
        return { decision: 'send' as const, feedback: '', retry: false };
      }
    };
    const conversation =
      run.kind === 'coordinator'
        ? await loadConversation(db, run.channelId, run.contextId ?? null, undefined)
        : await loadConversation(db, run.channelId, run.contextId ?? null, 40);

    const memories = await loadCoreMemories(
      db,
      run.userId,
      run.inputText,
      conversation.length > 0
    );
    const priorSpawnSignatures = await loadPriorSpawnSignatures(db, runId);

    const commitUserVisibleMessage = async (message: string, reason: string) => {
      if (run.kind === 'subagent') {
        return { committed: false as const, blockedReason: 'subagent' as const };
      }

      const commitDecision = decideUserMessageCommit(
        {
          hasCommitted: hasCommittedUserMessage,
          committedHash: committedUserMessageHash,
          committedNormalized: committedUserMessageNormalized,
        },
        message
      );

      await appendRunStep(db, {
        runId,
        seq: stepSeq++,
        type: 'message',
        resultJson: {
          event: 'commit_attempt',
          reason,
          hash: commitDecision.hash,
          normalized: commitDecision.normalized,
        },
      });

      if (!commitDecision.allowCommit) {
        await appendRunStep(db, {
          runId,
          seq: stepSeq++,
          type: 'message',
          resultJson: {
            event: 'commit_blocked',
            reason: commitDecision.reason,
            similarity: commitDecision.similarity ?? null,
            hash: commitDecision.hash,
          },
        });
        logger.info(
          {
            runId,
            reason,
            blockedReason: commitDecision.reason,
            similarity: commitDecision.similarity ?? null,
          },
          'Blocked user-visible commit'
        );
        return { committed: false as const, blockedReason: commitDecision.reason };
      }

      const sent = await sendRunMessage({
        db,
        userId: run.userId ?? '',
        channelId: run.channelId ?? '',
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
          resultJson: { event: 'commit_send_failed', reason },
        });
        return { committed: false as const, blockedReason: 'send_failed' as const };
      }

      hasCommittedUserMessage = true;
      committedUserMessageHash = commitDecision.hash;
      committedUserMessageNormalized = commitDecision.normalized;
      lastAssistantMessage = message;
      transcript.push({ type: 'assistant_message', content: message });

      await appendRunStep(db, {
        runId,
        seq: stepSeq++,
        type: 'assistant_message',
        resultJson: { message, reason, hash: commitDecision.hash },
      });
      await appendRunStep(db, {
        runId,
        seq: stepSeq++,
        type: 'message',
        resultJson: { event: 'commit_success', reason, hash: commitDecision.hash },
      });

      return { committed: true as const, blockedReason: null };
    };

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
        await commitUserVisibleMessage(message, reason);
      }
      logger.info('Run completed', { runId, reason });
      if (run.parentRunId) {
        await wakeParentRun(db, run.parentRunId, tenantId, agentId);
      }
    };

    if (run.wakeReason === 'tool_confirm') {
      const confirmation = await loadToolConfirmation(db, runId);
      if (confirmation?.status === 'pending') {
        logger.info({ runId }, 'Run still awaiting tool confirmation');
        return;
      }
      if (confirmation?.status === 'denied') {
        await db
          .update(runs)
          .set({ wakeReason: null, wakeAt: null, updatedAt: new Date() })
          .where(eq(runs.id, runId));
        await finishRun(
          confirmation.message ??
            'Tool execution was denied by the user. Let me know if you want a different approach.',
          'tool_confirm_denied'
        );
        return;
      }
      if (confirmation?.status === 'approved' && confirmation.toolCall) {
        await db
          .update(runs)
          .set({ wakeReason: null, wakeAt: null, updatedAt: new Date() })
          .where(eq(runs.id, runId));
        transcript.push({
          type: 'system_note',
          content: `User approved tool call ${confirmation.toolCall.name}. Executing now.`,
        });
        const result = await executeToolCall(
          confirmation.toolCall,
          {
            runId,
            tenantId,
            agentId,
            baseSeq: stepSeq,
            toolRegistry,
            policyEngine,
            budgetState,
            db,
            logger,
            toolConfigMap,
            run,
          },
          { confirmed: true, skipCallStep: true }
        );
        stepSeq += 2;
        transcript.push({ type: 'tool_result', name: confirmation.toolCall.name, result });
        if (!result.success) {
          const key = confirmation.toolCall.name;
          const count = (toolFailureCounts.get(key) ?? 0) + 1;
          toolFailureCounts.set(key, count);
          lastToolError = {
            tool: confirmation.toolCall.name,
            error: typeof result.error === 'string' ? result.error : undefined,
          };
          limitationRequired = true;
          limitationReason = result.error ?? 'tool_failed';
        } else {
          progressTick += 1;
        }
      }
    }
    const inputText = (run.inputText ?? '').trim();
    const greetingPattern =
      /^(hi|hey|hello|yo|sup|hola|hallo|guten tag|good (morning|afternoon|evening))\b/i;
    const fallbackMessage = greetingPattern.test(inputText)
      ? 'Hey! How can I help?'
      : 'Sorry, I got stuck while planning. Could you rephrase or be more specific?';

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

      await finishRun(fallbackMessage, reason);
      logger.info('Run completed after planning stall', { runId, iteration, reason });
      return true;
    };

    const recordIterationAndCheck = async (
      commandSignature: string | null,
      hadToolCall: boolean
    ) => {
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
        (entry) => entry.outputSnapshot === recentIterations[0]!.outputSnapshot
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
      // Check for cancellation at the start of each iteration
      const freshRunCheck = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
      const currentStatus = freshRunCheck[0]?.status;
      if (currentStatus === 'cancelled') {
        logger.info({ runId, iteration }, 'Run was cancelled');
        await appendRunStep(db, {
          runId,
          seq: stepSeq++,
          type: 'message',
          resultJson: { event: 'cancelled', iteration, reason: freshRunCheck[0]?.cancelReason },
        });
        // Run is already marked as cancelled, just exit
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
      budgetState.timeUsedMs = Date.now() - runStartMs;
      if (
        budgetState.tokensUsed > budgetState.tokensLimit ||
        budgetState.timeUsedMs > budgetState.timeLimitMs
      ) {
        limitationRequired = true;
        limitationReason = 'budget_exceeded';
        appendSystemNoteOnce(
          'Budget exceeded (tokens/time). Finish now with a brief limitation statement and best-effort output.'
        );
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
      const transcriptWindow = trimTranscript(
        transcript,
        config.runTranscriptLimit,
        config.runTranscriptTokenLimit
      );

      const subagentResults =
        run.kind === 'coordinator' ? await loadSubagentResults(db, runId) : [];

      const agentLevel = run.kind === 'subagent' ? ((run.inputJson as any)?.agentLevel ?? 1) : 0;

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

      const userContent = encodeUserPayload(userPayload);

      const messagesForModel: OpenAIMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ];
      budgetState.tokensUsed += estimateMessagesTokens(messagesForModel);
      budgetState.timeUsedMs = Date.now() - runStartMs;

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

      let command: RunCommand | SpawnCommand | null = null;
      let lastResponseText = '';
      const useStructuredOutputs = supportsStructuredOutputs(model);

      if (useStructuredOutputs) {
        // Use structured outputs for guaranteed valid JSON
        try {
          const parsedCommand = await callOpenAIStructuredWithFallback<Command>(
            apiKey,
            model,
            fallbackModel,
            messagesForModel,
            {
              name: 'run_command',
              description: 'A command for the agent to execute',
              strict: true,
              schema: commandJsonSchema,
            },
            { temperature: 0 }
          );
          lastResponseText = JSON.stringify(parsedCommand);
          budgetState.tokensUsed += Math.max(1, Math.ceil(lastResponseText.length / 4));
          if (config.runDebugPrompts) {
            logger.debug(
              { runId, iteration, responseText: lastResponseText },
              'Run model response (structured)'
            );
          }
          await appendRunStep(db, {
            runId,
            seq: stepSeq++,
            type: 'message',
            resultJson: {
              event: 'llm_response',
              iteration,
              attempt: 0,
              responseText: lastResponseText,
              structured: true,
            },
          });
          // Validate with Zod schema for extra safety
          const validated = commandSchema.safeParse(parsedCommand);
          if (validated.success) {
            command = validated.data as RunCommand | SpawnCommand;
          } else {
            logger.warn(
              { runId, iteration, errors: validated.error.issues },
              'Structured output failed Zod validation'
            );
            // Attempt canonicalize + repair before re-prompting
            const parseResult = parseRunCommand(lastResponseText);
            command = parseResult.command;
            if (!command && parseResult.validationError) {
              appendSystemNoteOnce(
                `Your last command was invalid: ${parseResult.validationError}. Reply with a corrected JSON command.`
              );
            }
          }
        } catch (err) {
          // Fall back to regular parsing if structured output fails
          logger.warn({ runId, iteration, error: err }, 'Structured output call failed, falling back');
          lastResponseText = await callOpenAIWithFallback(
            apiKey,
            model,
            fallbackModel,
            messagesForModel,
            { temperature: 0 }
          );
          budgetState.tokensUsed += Math.max(1, Math.ceil(lastResponseText.length / 4));
          await appendRunStep(db, {
            runId,
            seq: stepSeq++,
            type: 'message',
            resultJson: {
              event: 'llm_response',
              iteration,
              attempt: 0,
              responseText: lastResponseText,
              structured: false,
            },
          });
          const parseResult = parseRunCommand(lastResponseText);
          command = parseResult.command;
          if (!command && parseResult.validationError) {
            appendSystemNoteOnce(
              `Your last command was invalid: ${parseResult.validationError}. Reply with a corrected JSON command.`
            );
          }
        }
      } else {
        // Use traditional JSON parsing with retries
        for (let attempt = 0; attempt <= config.runMaxJsonRetries; attempt += 1) {
          lastResponseText = await callOpenAIWithFallback(
            apiKey,
            model,
            fallbackModel,
            messagesForModel,
            { temperature: 0 }
          );
          budgetState.tokensUsed += Math.max(1, Math.ceil(lastResponseText.length / 4));
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
          const parseResult = parseRunCommand(lastResponseText);
          command = parseResult.command;
          if (command) {
            if (parseResult.canonicalized || parseResult.repaired) {
              logger.info(
                { runId, iteration, attempt, canonicalized: parseResult.canonicalized, repaired: parseResult.repaired, repairDetails: parseResult.repairDetails },
                'Command canonicalized/repaired before validation'
              );
            }
            break;
          }
          const errorMsg = parseResult.validationError
            ? `Your last command was invalid: ${parseResult.validationError}. Reply with a corrected JSON command.`
            : 'Invalid JSON response received. Please reply with a single valid JSON command object only.';
          appendSystemNoteOnce(errorMsg);
        }
      }

      if (!command) {
        await appendRunStep(db, {
          runId,
          seq: stepSeq++,
          type: 'message',
          resultJson: { error: 'invalid_json', rawResponse: lastResponseText.slice(0, 2000) },
        });
        await finishRun(
          'Sorry, I had trouble understanding that request. Please try again.',
          'invalid_json'
        );
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
        appendSystemNoteOnce('Proceeding without set_run_limits; using the current run budget.');
        runLimitsSet = true;
      }

      // Rationale enforcement removed - let LLM respond directly for simple messages

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

      // Allow send_message even when limited - agent may need to ask for clarification
      if (limitationRequired && command.type !== 'finish' && command.type !== 'send_message') {
        appendSystemNoteOnce(
          `A required tool failed (${limitationReason ?? 'unknown_error'}). Either ask the user for missing information with send_message, or finish with a limitation statement.`
        );
        if (await recordIterationAndCheck('blocked:limitation', false)) {
          return;
        }
        continue;
      }

      if (command.type === 'recover') {
        actionCount += 1;
        rationaleReady = false;
        forceActionNext = false;
        actionViolationCount = 0;
        consecutiveNotes = 0;
        const reason = command.reason?.trim() || 'unspecified';
        await appendRunStep(db, {
          runId,
          seq: stepSeq++,
          type: 'recovery',
          resultJson: { reason, action: command.action ?? 'retry', message: command.message ?? null },
        });
        transcript.push({ type: 'recovery', reason, action: command.action });
        if (command.action === 'finish') {
          const message =
            command.message?.trim() ||
            'I encountered a formatting or planning issue and stopped to avoid a bad answer.';
          await appendRunStep(db, {
            runId,
            seq: stepSeq++,
            type: 'message',
            resultJson: { event: 'draft_message', source: 'recover_finish', message },
          });
          const validation = await validateOutput(message, 'recover_finish', userPayload);
          if (validation.decision === 'revise') {
            appendSystemNoteOnce(
              `Validation requested changes: ${validation.feedback || 'Improve clarity and correctness.'}`
            );
            await appendRunStep(db, {
              runId,
              seq: stepSeq++,
              type: 'message',
              resultJson: {
                event: 'validation_feedback',
                feedback: validation.feedback,
                retry: validation.retry,
              },
            });
            if (validation.retry) {
              limitationRequired = false;
              limitationReason = null;
            }
            continue;
          }
          await finishRun(message, 'recover_finish');
          return;
        }
        if (command.action === 'ask_user') {
          const message =
            command.message?.trim() ||
            'I need clarification before I can proceed. Could you specify the missing details?';
          await appendRunStep(db, {
            runId,
            seq: stepSeq++,
            type: 'message',
            resultJson: { event: 'draft_message', source: 'recover_ask_user', message },
          });
          const validation = await validateOutput(message, 'recover_ask_user', userPayload);
          if (validation.decision === 'revise') {
            appendSystemNoteOnce(
              `Validation requested changes: ${validation.feedback || 'Improve clarity and correctness.'}`
            );
            await appendRunStep(db, {
              runId,
              seq: stepSeq++,
              type: 'message',
              resultJson: {
                event: 'validation_feedback',
                feedback: validation.feedback,
                retry: validation.retry,
              },
            });
            if (validation.retry) {
              limitationRequired = false;
              limitationReason = null;
            }
            continue;
          }
          await finishRun(message, 'recover_ask_user');
          return;
        }
        appendSystemNoteOnce(
          `Recovery requested: ${reason}. Continue with the JSON-only contract and take the next best action.`
        );
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
        const toolCall: ToolCall = {
          id: nanoid(),
          name: command.name,
          args: command.args ?? {},
        };

        const toolSignature = `tool:${toolCall.name}:${stableStringify(toolCall.args)}`;
        const toolCount = (repeatedCallCounts.get(toolSignature) ?? 0) + 1;
        repeatedCallCounts.set(toolSignature, toolCount);
        if (toolCount > 2) {
          await appendRunStep(db, {
            runId,
            seq: stepSeq++,
            type: 'message',
            resultJson: { event: 'loop_detected', kind: 'tool', name: toolCall.name },
          });
          limitationRequired = true;
          limitationReason = 'repeated_tool_call_loop';
          appendSystemNoteOnce(
            `You already called "${toolCall.name}" with the same arguments repeatedly. Do not call it again. Use existing tool results to answer the user with send_message, or finish with a brief limitation if evidence is insufficient.`
          );
          if (await recordIterationAndCheck(`loop_detected:${toolCall.name}`, false)) {
            return;
          }
          continue;
        }

        transcript.push({ type: 'tool_call', name: toolCall.name, args: toolCall.args });

        if (config.runDebugPrompts) {
          logger.debug({ runId, iteration, toolCall: truncateForLog(toolCall) }, 'Run tool call');
        }

        const result = await executeToolCall(toolCall, {
          runId,
          tenantId,
          agentId,
          baseSeq: stepSeq,
          toolRegistry,
          policyEngine,
          budgetState,
          db,
          logger,
          toolConfigMap,
          run,
        });
        if (result.pending) {
          stepSeq += 2;
          transcript.push({ type: 'tool_result', name: toolCall.name, result });
          logger.info({ runId, tool: toolCall.name }, 'Tool call awaiting confirmation');
          return;
        }

        stepSeq += 2;
        transcript.push({ type: 'tool_result', name: toolCall.name, result });
        if (config.runDebugPrompts) {
          logger.debug({ runId, iteration, toolResult: truncateForLog(result) }, 'Run tool result');
        }
        const toolResultSignature = `tool_result:${toolCall.name}:${stableStringify(
          toolCall.args
        )}:${stableStringify(result)}`;
        const resultCount = (repeatedResultCounts.get(toolResultSignature) ?? 0) + 1;
        repeatedResultCounts.set(toolResultSignature, resultCount);
        if (result.success) {
          progressTick += 1;
          // Track provenance for web tools
          const toolBase = toolCall.name.split('.')[0];
          const toolCmd = toolCall.name.split('.')[1];
          if (toolBase === 'web') {
            if (toolCmd === 'search' && typeof toolCall.args.query === 'string') {
              provenanceTracker.recordSearch(toolCall.args.query);
            } else if (toolCmd === 'fetch' && typeof toolCall.args.url === 'string') {
              provenanceTracker.recordFetch(toolCall.args.url);
            } else if (toolCmd === 'extract' && typeof toolCall.args.url === 'string') {
              provenanceTracker.recordExtract(
                toolCall.args.url,
                String(toolCall.args.extractType ?? 'unknown'),
                result.result
              );
            }
          }
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
              `Tool \"${toolCall.name}\" failed (${errorText}). Ask the user for missing information, try a different approach, or finish with what you have.`
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
          throw new Error('send_message requires a non-empty message');
        }

        // Check grounding before sending message with numeric claims
        const groundingNudge = provenanceTracker.checkOutputGrounding(message);
        if (groundingNudge && run.kind !== 'subagent') {
          appendSystemNoteOnce(groundingNudge);
          continue;
        }

        if (run.kind === 'subagent') {
          outputText = message;
          await appendRunStep(db, {
            runId,
            seq: stepSeq++,
            type: 'assistant_message',
            resultJson: { message },
          });
          await finishRun(message, 'subagent_message');
          logger.info('Subagent completed via send_message draft', { runId });
          return;
        }

        outputText = message;
        lastAssistantMessage = message;
        await appendRunStep(db, {
          runId,
          seq: stepSeq++,
          type: 'message',
          resultJson: { event: 'draft_message', source: 'send_message', message },
        });
        const validation = await validateOutput(message, 'send_message', userPayload);
        if (validation.decision === 'revise') {
          appendSystemNoteOnce(
            `Validation requested changes: ${validation.feedback || 'Improve clarity and correctness.'}`
          );
          await appendRunStep(db, {
            runId,
            seq: stepSeq++,
            type: 'message',
            resultJson: {
              event: 'validation_feedback',
              feedback: validation.feedback,
              retry: validation.retry,
            },
          });
          if (validation.retry) {
            limitationRequired = false;
            limitationReason = null;
          }
          continue;
        }

        await finishRun(message, 'send_message');
        return;
      }

      if (command.type === 'set_output') {
        actionCount += 1;
        rationaleReady = false;
        forceActionNext = false;
        actionViolationCount = 0;
        consecutiveNotes = 0;
        const nextOutput = applyOutputUpdate(outputText, command.output, command.mode);
        const outputChanged = nextOutput !== outputText;
        outputText = nextOutput;
        if (outputChanged) {
          progressTick += 1;
        }

        await db.update(runs).set({ outputText, updatedAt: new Date() }).where(eq(runs.id, runId));

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
            resultJson: {
              event: 'validation_feedback',
              feedback: validation.feedback,
              retry: validation.retry,
            },
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
          throw new Error('decision requires non-empty content');
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
          throw new Error('note requires non-empty content');
        }
        // Just record the note and continue - no validation or enforcement
        await appendRunStep(db, {
          runId,
          seq: stepSeq++,
          type: 'message',
          resultJson: { event: 'note', category: command.category, content },
        });
        transcript.push({ type: 'note', category: command.category, content });
        noteCounts[command.category as keyof typeof noteCounts] += 1;
        continue;
      }

      if (command.type === 'finish') {
        actionCount += 1;
        rationaleReady = false;
        forceActionNext = false;
        actionViolationCount = 0;
        consecutiveNotes = 0;
        if (command.output) {
          outputText = applyOutputUpdate(outputText, command.output, command.mode);
        }

        const finalOutput = outputText.trim() || lastAssistantMessage.trim();
        if (!finalOutput) {
          throw new Error('Finish called without output or prior message');
        }

        await appendRunStep(db, {
          runId,
          seq: stepSeq++,
          type: 'message',
          resultJson: { event: 'draft_message', source: 'finish', message: finalOutput },
        });

        const validation = await validateOutput(finalOutput, 'finish', userPayload);
        if (validation.decision === 'revise') {
          appendSystemNoteOnce(
            `Validation requested changes: ${validation.feedback || 'Improve clarity and correctness.'}`
          );
          await appendRunStep(db, {
            runId,
            seq: stepSeq++,
            type: 'message',
            resultJson: {
              event: 'validation_feedback',
              feedback: validation.feedback,
              retry: validation.retry,
            },
          });
          if (validation.retry) {
            limitationRequired = false;
            limitationReason = null;
          }
          continue;
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
        const wakeAtDate = computeWakeAt(command.wakeAt, command.delaySeconds);
        await appendRunStep(db, {
          runId,
          seq: stepSeq++,
          type: 'message',
          resultJson: {
            event: 'sleep',
            reason: command.reason ?? null,
            wakeAt: wakeAtDate ? wakeAtDate.toISOString() : (command.wakeAt ?? null),
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
        const agentLevel = run.kind === 'subagent' ? ((run.inputJson as any)?.agentLevel ?? 1) : 0;
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
        const subagents =
          command.type === 'spawn_subagent' ? [command.subagent] : command.subagents;
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
            await finishRun(message, 'repeat_spawn');
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
            await finishRun(message, 'subagent_failed');
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
    await db
      .update(runs)
      .set({ status: 'failed', updatedAt: new Date() })
      .where(eq(runs.id, runId));

    if (run.kind !== 'subagent' && !hasCommittedUserMessage) {
      try {
        const message = lastToolError?.error
          ? `Sorry, something went wrong while handling that request. Error: ${lastToolError.error}`
          : 'Sorry, something went wrong while handling that request.';
        await sendRunMessage({
          db,
          userId: run.userId ?? '',
          channelId: run.channelId ?? '',
          contextId: run.contextId ?? null,
          content: message,
          logger,
          runId,
          runKind: run.kind ?? 'coordinator',
        });
      } catch (sendErr) {
        logger.error({ runId, err: sendErr }, 'Failed to send error message');
      }
    } else if (run.kind !== 'subagent') {
      logger.info({ runId }, 'Skipping error message because a user-visible message was already committed');
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
  budgetState: BudgetState;
  db: ReturnType<typeof getDb>;
  logger: Logger;
  toolConfigMap: Map<string, Record<string, unknown>>;
  run: typeof runs.$inferSelect;
}

async function executeToolCall(
  toolCall: ToolCall,
  ctx: ToolCallContext,
  options?: { confirmed?: boolean; skipCallStep?: boolean }
): Promise<ToolResult> {
  const {
    runId,
    tenantId,
    agentId,
    baseSeq,
    toolRegistry,
    policyEngine,
    budgetState,
    db,
    logger,
    toolConfigMap,
    run,
  } = ctx;

  if (!options?.confirmed || !options?.skipCallStep) {
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
  }

  const parsedName = parseToolCommandName(toolCall.name);
  if (!parsedName) {
    const fallbackTool = toolRegistry.getTool(toolCall.name);
    if (fallbackTool && fallbackTool.commands.length === 1) {
      const onlyCommand = fallbackTool.commands[0]?.name;
      if (onlyCommand) {
        return await executeToolCall({ ...toolCall, name: `${toolCall.name}.${onlyCommand}` }, ctx);
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

  // Pre-validate tool arguments before policy check or execution
  const argsValidation = commandDef.argsSchema.safeParse(toolCall.args);
  if (!argsValidation.success) {
    const result: ToolResult = {
      id: toolCall.id,
      success: false,
      error: 'invalid_args',
      result: {
        error_code: 'invalid_args',
        error_message: 'Tool arguments failed pre-validation.',
        details: argsValidation.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
          code: issue.code,
        })),
      },
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
      runKind: run.kind ?? 'coordinator',
    },
    toolDef,
    budgetState
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

  if (decision === 'confirm' && !options?.confirmed) {
    if (run.kind === 'subagent') {
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

    const requestId = nanoid();
    await db.insert(runSteps).values({
      runId,
      seq: baseSeq + 1,
      type: 'tool_confirm_request',
      toolName: toolCall.name,
      argsJson: toolCall.args,
      resultJson: {
        requestId,
        toolCall,
        classification: commandDef.classification,
        requestedAt: new Date().toISOString(),
      },
      status: 'completed',
      idempotencyKey: `${runId}:confirm_request:${toolCall.id}`,
    });
    await db
      .update(runs)
      .set({ status: 'waiting', wakeReason: 'tool_confirm', updatedAt: new Date() })
      .where(eq(runs.id, runId));

    const confirmMessage =
      `This action needs confirmation before I can proceed: ${toolCall.name}. ` +
      `Approve or deny via the run confirmation API. Request ID: ${requestId}.`;
    if (run.kind !== 'subagent') {
      await sendRunMessage({
        db,
        userId: run.userId ?? '',
        channelId: run.channelId ?? '',
        contextId: run.contextId ?? null,
        content: confirmMessage,
        logger,
        runId,
        runKind: run.kind ?? 'coordinator',
      });
    }

    const result: ToolResult = {
      id: toolCall.id,
      success: false,
      error: 'confirmation_required',
      pending: true,
      result: { requestId },
    };
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
        userId: run.userId ?? undefined,
        channelId: run.channelId ?? undefined,
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
      error: payloadSuccess
        ? undefined
        : String((resultPayload as { error?: unknown }).error ?? ''),
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

interface ParseResult {
  command: (RunCommand | SpawnCommand) | null;
  validationError: string | null;
  canonicalized: boolean;
  repaired: boolean;
  repairDetails: string[];
}

function parseRunCommand(responseText: string): ParseResult {
  const fail = (validationError: string | null = null): ParseResult => ({
    command: null,
    validationError,
    canonicalized: false,
    repaired: false,
    repairDetails: [],
  });

  try {
    let raw = responseText.trim();
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      const candidate = extractFirstJsonObject(raw);
      if (!candidate) return fail();
      parsed = JSON.parse(candidate) as Record<string, unknown>;
    }
    if (!parsed || typeof parsed !== 'object') {
      return fail();
    }

    // Step 1: Canonicalize the raw object
    const canonicalized = canonicalize(parsed);
    const wasCanonicalized = JSON.stringify(canonicalized) !== JSON.stringify(parsed);

    // Step 2: Validate with Zod schema
    const schemaResult = commandSchema.safeParse(canonicalized);
    if (schemaResult.success) {
      return {
        command: schemaResult.data as RunCommand | SpawnCommand,
        validationError: null,
        canonicalized: wasCanonicalized,
        repaired: false,
        repairDetails: [],
      };
    }

    // Step 3: Attempt repair
    const repairResult = repair(canonicalized, schemaResult.error);
    if (repairResult) {
      const revalidated = commandSchema.safeParse(repairResult.repaired);
      if (revalidated.success) {
        return {
          command: revalidated.data as RunCommand | SpawnCommand,
          validationError: null,
          canonicalized: wasCanonicalized,
          repaired: true,
          repairDetails: repairResult.applied,
        };
      }
    }

    // Step 4: Return validation error for re-prompting
    return {
      command: null,
      validationError: formatValidationError(schemaResult.error),
      canonicalized: wasCanonicalized,
      repaired: false,
      repairDetails: [],
    };
  } catch {
    return fail();
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

function trimTranscript(transcript: TranscriptEntry[], maxEntries: number, maxTokens: number) {
  const limited = transcript.slice(-maxEntries);
  let totalTokens = 0;
  const result: TranscriptEntry[] = [];
  for (let i = limited.length - 1; i >= 0; i -= 1) {
    const entry = limited[i]!;
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

function estimateMessagesTokens(messages: OpenAIMessage[]) {
  const raw = JSON.stringify(messages);
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

const WEB_QA_PATTERN = /^(what|how|who|where|when|search|find|look\s*up|average|rating|score|imdb|bewertung|durchschnitt)/i;

async function loadCoreMemories(
  db: ReturnType<typeof getDb>,
  userId: string,
  taskText?: string,
  hasConversation?: boolean
) {
  // Skip memories for pure web Q&A tasks (no conversation context)
  if (
    config.memorySkipForWebQA &&
    !hasConversation &&
    taskText &&
    WEB_QA_PATTERN.test(taskText.trim())
  ) {
    return [];
  }

  const rows = await db
    .select()
    .from(memoryItems)
    .where(and(eq(memoryItems.userId, userId), eq(memoryItems.archived, false)));

  // Filter by confidence threshold (pinned items bypass threshold)
  const filtered = rows.filter(
    (item) => item.pinned || (item.confidence ?? 1) >= config.memoryMinConfidence
  );

  const byLevel = new Map<number, typeof filtered>();
  for (const item of filtered) {
    const list = byLevel.get(item.level) ?? [];
    list.push(item);
    byLevel.set(item.level, list);
  }

  for (const list of byLevel.values()) {
    list.sort((a, b) => (b.lastSeenAt?.getTime?.() ?? 0) - (a.lastSeenAt?.getTime?.() ?? 0));
  }

  let selected: typeof filtered = [];
  for (const level of [0, 1, 2, 3, 4, 5]) {
    const list = byLevel.get(level) ?? [];
    selected.push(...list.slice(0, 5));
  }

  // Keyword overlap filter: discard memories with zero relevance to the task
  if (taskText && taskText.length > 20) {
    const taskTokens = new Set(
      taskText
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 2)
    );
    if (taskTokens.size > 0) {
      selected = selected.filter((item) => {
        if (item.pinned) return true; // Always keep pinned
        const memoryText = `${item.key ?? ''} ${item.value ?? ''} ${item.module ?? ''}`;
        const memoryTokens = memoryText
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, ' ')
          .split(/\s+/)
          .filter((t) => t.length > 2);
        return memoryTokens.some((token) => taskTokens.has(token));
      });
    }
  }

  // Cap total memories
  selected = selected.slice(0, config.memoryMaxItems);

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

async function loadToolConfirmation(db: ReturnType<typeof getDb>, runId: string) {
  const steps = await db
    .select({ type: runSteps.type, seq: runSteps.seq, resultJson: runSteps.resultJson })
    .from(runSteps)
    .where(
      and(
        eq(runSteps.runId, runId),
        inArray(runSteps.type, ['tool_confirm_request', 'tool_confirm'])
      )
    )
    .orderBy(desc(runSteps.seq));

  const request = steps.find((step) => step.type === 'tool_confirm_request');
  if (!request) return null;
  const requestJson = request.resultJson as {
    requestId?: string;
    toolCall?: ToolCall;
  } | null;
  if (!requestJson?.requestId || !requestJson.toolCall) return null;

  const confirm = steps.find(
    (step) =>
      step.type === 'tool_confirm' &&
      (step.resultJson as { requestId?: string } | null)?.requestId === requestJson.requestId
  );
  if (!confirm) {
    return { status: 'pending' as const, requestId: requestJson.requestId };
  }
  const confirmJson = confirm.resultJson as { decision?: string; message?: string } | null;
  if (confirmJson?.decision === 'approve') {
    return {
      status: 'approved' as const,
      requestId: requestJson.requestId,
      toolCall: requestJson.toolCall,
    };
  }
  return {
    status: 'denied' as const,
    requestId: requestJson.requestId,
    message: confirmJson?.message,
  };
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

function stableStringify(value: unknown): string {
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

function stripCodeFences(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const lines = trimmed.split('\n');
  if (lines.length <= 2) return trimmed;
  const withoutFenceStart = lines.slice(1);
  const fenceEndIndex = withoutFenceStart.findIndex((line) => line.trim().startsWith('```'));
  if (fenceEndIndex === -1) return withoutFenceStart.join('\n').trim();
  return withoutFenceStart.slice(0, fenceEndIndex).join('\n').trim();
}

function extractFirstJsonObject(text: string): string | null {
  const trimmed = stripCodeFences(text);
  if (!trimmed) return null;
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }
  let inString = false;
  let escape = false;
  let depth = 0;
  let start = -1;
  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === '\\\\') {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        return trimmed.slice(start, i + 1);
      }
    }
  }
  return null;
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
        contextId ? eq(messages.contextId, contextId) : isNull(messages.contextId)
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
