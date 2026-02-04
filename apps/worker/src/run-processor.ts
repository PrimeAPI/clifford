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
  userToolSettings,
} from '@clifford/db';
import { eq, and } from 'drizzle-orm';
import { PolicyEngine } from '@clifford/policy';
import { ToolRegistry } from './tool-registry.js';
import { nanoid } from 'nanoid';
import { config } from './config.js';
import { decryptSecret } from './crypto.js';
import { callOpenAIWithFallback, type OpenAIMessage } from './openai-client.js';
import { enqueueDelivery } from './queues.js';
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
    };

type TranscriptEntry =
  | { type: 'assistant_message'; content: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; result: unknown }
  | { type: 'output_update'; output: string; mode: 'replace' | 'append' }
  | { type: 'system_note'; content: string };

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

    const patchedTools = enabledTools.map((tool) => {
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

    const toolDescriptions = buildToolPrompt(toolRegistry.getAllTools());

    const systemPrompt =
      'You are a task agent. You MUST respond with a single JSON object only. ' +
      'No prose, no markdown. The JSON must match one of these shapes:\n' +
      '1) {"type":"tool_call","name":"tool.command","args":{...}}\n' +
      '2) {"type":"send_message","message":"..."}\n' +
      '3) {"type":"set_output","output":"...","mode":"replace"|"append"}\n' +
      '4) {"type":"finish","output":"...","mode":"replace"|"append"}\n' +
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
      'Use the conversation field for user context. ' +
      'If the user asks what tools you have or what you can do, call tools.list. ' +
      'If the user asks for current weather, call tools.list and then the weather tool if available. ' +
      'If you need tools, use tool_call and wait for tool_result in the transcript. ' +
      'Use tools.list to see all tools and short descriptions. ' +
      'Use tools.describe to see full details for a specific tool.\n\n' +
      toolDescriptions;

    const transcript: TranscriptEntry[] = [];
  let outputText = run.outputText ?? '';
  let lastAssistantMessage = '';
  const conversation = await loadConversation(db, run.channelId, run.contextId ?? null);

    for (let iteration = 0; iteration < config.runMaxIterations; iteration += 1) {
      const transcriptWindow = trimTranscript(transcript, config.runTranscriptLimit, config.runTranscriptTokenLimit);

      const userPayload = {
        task: run.inputText,
        output: outputText,
        conversation,
        transcript: transcriptWindow,
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
        transcript.push({
          type: 'system_note',
          content: `Invalid JSON response received. Please reply with a single valid JSON command object only.`,
        });
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
        });
        throw new Error('LLM returned invalid JSON for run command');
      }

      if (command.type === 'tool_call') {
        const toolCall: ToolCall = {
          id: nanoid(),
          name: command.name,
          args: command.args ?? {},
        };

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
        });

        stepSeq += 2;
        transcript.push({ type: 'tool_result', name: toolCall.name, result });
        if (config.runDebugPrompts) {
          logger.debug(
            { runId, iteration, toolResult: truncateForLog(result) },
            'Run tool result'
          );
        }
        continue;
      }

      if (command.type === 'send_message') {
        const message = command.message?.trim();
        if (!message) {
          throw new Error('send_message requires a non-empty message');
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

        await sendRunMessage({
          db,
          userId: run.userId,
          channelId: run.channelId,
          contextId: run.contextId ?? null,
          content: message,
          logger,
        });

        transcript.push({ type: 'assistant_message', content: message });
        lastAssistantMessage = message;

        const hasToolCalls = transcriptWindow.some((entry) => entry.type === 'tool_call');
        const hasOutputUpdates = transcriptWindow.some((entry) => entry.type === 'output_update');
        if (!hasToolCalls && !hasOutputUpdates && !outputText) {
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
        continue;
      }

      if (command.type === 'set_output') {
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
        continue;
      }

      if (command.type === 'finish') {
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

        if (finalOutput !== lastAssistantMessage.trim()) {
          await sendRunMessage({
            db,
            userId: run.userId,
            channelId: run.channelId,
            contextId: run.contextId ?? null,
            content: finalOutput,
            logger,
          });
        }

        logger.info('Run completed', { runId });
        return;
      }
    }

    const finalOutput = outputText.trim() || lastAssistantMessage.trim();
    if (finalOutput) {
      await db
        .update(runs)
        .set({ outputText: finalOutput, status: 'completed', updatedAt: new Date() })
        .where(eq(runs.id, runId));
      await appendRunStep(db, {
        runId,
        seq: stepSeq++,
        type: 'finish',
        resultJson: { output: finalOutput, reason: 'max_iterations' },
      });
      await sendRunMessage({
        db,
        userId: run.userId,
        channelId: run.channelId,
        contextId: run.contextId ?? null,
        content: finalOutput,
        logger,
      });
      logger.info('Run completed after max iterations', { runId });
      return;
    }

    throw new Error('Run exceeded max iterations without finish');
  } catch (err) {
    logger.error('Run failed', { runId, err });
    await db.update(runs).set({ status: 'failed', updatedAt: new Date() }).where(eq(runs.id, runId));
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
}

async function executeToolCall(toolCall: ToolCall, ctx: ToolCallContext): Promise<ToolResult> {
  const { runId, tenantId, agentId, baseSeq, toolRegistry, policyEngine, db, logger, toolConfigMap } =
    ctx;

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

    const result: ToolResult = {
      id: toolCall.id,
      success: true,
      result: resultPayload,
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

function parseRunCommand(responseText: string): RunCommand | null {
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
        parsed.type === 'finish'
      ) {
        return parsed as RunCommand;
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

function buildToolPrompt(tools: ToolDef[]) {
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
}: {
  db: ReturnType<typeof getDb>;
  userId: string;
  channelId: string;
  contextId: string | null;
  content: string;
  logger: Logger;
}) {
    const [channel] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
  if (!channel || channel.userId !== userId) {
    throw new Error('Channel not found for run message');
  }

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
      }),
    })
    .returning();

  if (!outbound) {
    throw new Error('Failed to create outbound run message');
  }

  if (channel.type === 'discord') {
    let discordUserId: string | undefined;

    const configValue = channel.config as { discordUserId?: string } | null;
    if (configValue?.discordUserId) {
      discordUserId = configValue.discordUserId;
    }

    if (!discordUserId) {
      throw new Error('Discord user ID missing; cannot send DM');
    }

    await enqueueDelivery({
      type: 'delivery',
      provider: 'discord',
      messageId: outbound.id,
      payload: {
        discordUserId,
        content,
      },
    });
  }

  logger.info({ channelId, messageId: outbound.id }, 'Run message sent');
}

async function loadConversation(
  db: ReturnType<typeof getDb>,
  channelId: string,
  contextId: string | null
) {
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.channelId, channelId),
        contextId ? eq(messages.contextId, contextId) : eq(messages.contextId, null)
      )
    )
    .orderBy(messages.createdAt)
    .limit(20);

  return rows.map((row) => ({
    role: row.direction === 'inbound' ? 'user' : 'assistant',
    content: row.content,
  }));
}
