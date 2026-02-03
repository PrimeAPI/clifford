import type { Job } from 'bullmq';
import type { RunJob, Logger, ToolCall } from '@clifford/sdk';
import { getDb, runs, runSteps, agentPlugins } from '@clifford/db';
import { eq, and } from 'drizzle-orm';
import { PolicyEngine } from '@clifford/policy';
import { ToolRegistry } from './tool-registry.js';
import { llmStub } from './llm-stub.js';
import { nanoid } from 'nanoid';

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

  // Update status to running
  await db.update(runs).set({ status: 'running', updatedAt: new Date() }).where(eq(runs.id, runId));

  try {
    // 2. Load agent plugins
    const plugins = await db
      .select()
      .from(agentPlugins)
      .where(and(eq(agentPlugins.agentId, agentId), eq(agentPlugins.enabled, true)));

    const pluginNames = plugins.map((p) => p.pluginName);

    // 3. Register tools
    const toolRegistry = new ToolRegistry();
    await toolRegistry.loadPlugins(pluginNames);

    // 4. Initialize policy engine
    const policyEngine = new PolicyEngine();

    // 5. Call LLM stub
    const llmResponse = await llmStub(run.inputText);

    let stepSeq = 0;

    if (llmResponse.type === 'message') {
      // Write message step
      await db.insert(runSteps).values({
        runId,
        seq: stepSeq++,
        type: 'message',
        resultJson: { message: llmResponse.message },
        status: 'completed',
        idempotencyKey: nanoid(),
      });
    } else {
      // Process tool calls
      for (const toolCall of llmResponse.toolCalls) {
        await processToolCall(toolCall, {
          runId,
          tenantId,
          agentId,
          stepSeq: stepSeq++,
          toolRegistry,
          policyEngine,
          db,
          logger,
        });
      }
    }

    // Mark run as completed
    await db
      .update(runs)
      .set({ status: 'completed', updatedAt: new Date() })
      .where(eq(runs.id, runId));

    logger.info('Run completed', { runId });
  } catch (err) {
    logger.error('Run failed', { runId, err });
    await db.update(runs).set({ status: 'failed', updatedAt: new Date() }).where(eq(runs.id, runId));
    throw err;
  }
}

interface ToolCallContext {
  runId: string;
  tenantId: string;
  agentId: string;
  stepSeq: number;
  toolRegistry: ToolRegistry;
  policyEngine: PolicyEngine;
  db: ReturnType<typeof getDb>;
  logger: Logger;
}

async function processToolCall(toolCall: ToolCall, ctx: ToolCallContext) {
  const { runId, tenantId, agentId, stepSeq, toolRegistry, policyEngine, db, logger } = ctx;

  // Write tool_call step
  const callStepKey = `${runId}:call:${toolCall.id}`;
  await db.insert(runSteps).values({
    runId,
    seq: stepSeq,
    type: 'tool_call',
    toolName: toolCall.name,
    argsJson: toolCall.args,
    status: 'completed',
    idempotencyKey: callStepKey,
  });

  // Get tool definition
  const toolDef = toolRegistry.getTool(toolCall.name);
  if (!toolDef) {
    logger.error('Tool not found', { toolName: toolCall.name });
    await db.insert(runSteps).values({
      runId,
      seq: stepSeq + 1,
      type: 'tool_result',
      toolName: toolCall.name,
      resultJson: { success: false, error: 'Tool not found' },
      status: 'failed',
      idempotencyKey: `${runId}:result:${toolCall.id}`,
    });
    return;
  }

  // Check policy
  const decision = await policyEngine.decideToolCall(
    { tenantId, agentId, toolName: toolCall.name, args: toolCall.args, policyProfile: 'default' },
    toolDef
  );

  if (decision === 'deny') {
    logger.warn('Tool call denied by policy', { toolName: toolCall.name });
    await db.insert(runSteps).values({
      runId,
      seq: stepSeq + 1,
      type: 'tool_result',
      toolName: toolCall.name,
      resultJson: { success: false, error: 'Denied by policy' },
      status: 'failed',
      idempotencyKey: `${runId}:result:${toolCall.id}`,
    });
    return;
  }

  // Execute tool
  try {
    const result = await toolDef.handler(
      { tenantId, agentId, runId, db, logger },
      toolCall.args
    );

    // Write tool_result step
    await db.insert(runSteps).values({
      runId,
      seq: stepSeq + 1,
      type: 'tool_result',
      toolName: toolCall.name,
      resultJson: result as Record<string, unknown>,
      status: 'completed',
      idempotencyKey: `${runId}:result:${toolCall.id}`,
    });
  } catch (err) {
    logger.error('Tool execution failed', { toolName: toolCall.name, err });
    await db.insert(runSteps).values({
      runId,
      seq: stepSeq + 1,
      type: 'tool_result',
      toolName: toolCall.name,
      resultJson: { success: false, error: String(err) },
      status: 'failed',
      idempotencyKey: `${runId}:result:${toolCall.id}`,
    });
  }
}
