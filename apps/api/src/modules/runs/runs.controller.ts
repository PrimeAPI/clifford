import type { FastifyInstance } from 'fastify';
import { getDb, runs, runSteps } from '@clifford/db';
import { eq, and, desc } from 'drizzle-orm';
import { enqueueRun } from '../../queue.js';
import { confirmRunSchema, createRunSchema, listRunsQuerySchema } from './runs.schema.js';
import {
  createRunRecord,
  ensureRunChannelAccess,
  getRunDetails,
  listRunChildren,
  listRunsForTenant,
} from './runs.service.js';

export async function runRoutes(app: FastifyInstance) {
  // List recent runs
  app.get('/api/runs', async (req, reply) => {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return reply.status(400).send({ error: 'Missing X-Tenant-Id header' });
    }

    const query = listRunsQuerySchema.parse(req.query);
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const db = getDb();
    const { total, runs: recentRuns } = await listRunsForTenant(db, tenantId, limit, offset);

    return {
      runs: recentRuns,
      total,
      limit,
      offset,
      hasMore: offset + recentRuns.length < total,
    };
  });

  // Create a new run
  app.post('/api/runs', async (req, reply) => {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return reply.status(400).send({ error: 'Missing X-Tenant-Id header' });
    }
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(400).send({ error: 'Missing X-User-Id header' });
    }

    const body = createRunSchema.parse(req.body);
    const db = getDb();

    const channel = await ensureRunChannelAccess(db, body.channelId);
    if (!channel || channel.userId !== userId) {
      return reply.status(404).send({ error: 'Channel not found' });
    }

    const runId = await createRunRecord(db, {
      tenantId,
      agentId: body.agentId,
      userId,
      channelId: body.channelId,
      contextId: body.contextId ?? null,
      inputText: body.inputText,
    });

    // Enqueue job
    await enqueueRun({
      type: 'run',
      runId,
      tenantId,
      agentId: body.agentId,
    });

    app.log.info({ runId, agentId: body.agentId }, 'Run created and enqueued');

    return { runId, status: 'pending' };
  });

  // Get run details
  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    const { id } = req.params;
    const db = getDb();

    const result = await getRunDetails(db, id);
    if (!result) {
      return reply.status(404).send({ error: 'Run not found' });
    }

    return result;
  });

  // List subagent runs for a coordinator
  app.get<{ Params: { id: string } }>('/api/runs/:id/children', async (req, reply) => {
    const { id } = req.params;
    const db = getDb();

    const result = await listRunChildren(db, id);
    return result;
  });

  // SSE stream for run updates
  app.get<{ Params: { id: string } }>('/api/runs/:id/stream', async (req, reply) => {
    const { id } = req.params;
    const db = getDb();

    // Check if run exists
    const run = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
    if (run.length === 0) {
      return reply.status(404).send({ error: 'Run not found' });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    let lastSeq = 0;
    const interval = setInterval(async () => {
      try {
        const newSteps = await db
          .select()
          .from(runSteps)
          .where(eq(runSteps.runId, id))
          .orderBy(runSteps.seq);

        if (newSteps.length > lastSeq) {
          for (let i = lastSeq; i < newSteps.length; i++) {
            const step = newSteps[i];
            reply.raw.write(`data: ${JSON.stringify(step)}\n\n`);
          }
          lastSeq = newSteps.length;
        }

        // Check if run completed
        const currentRun = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
        const status = currentRun[0]?.status;
        if (status === 'completed' || status === 'failed' || status === 'cancelled') {
          clearInterval(interval);
          reply.raw.end();
        }
      } catch (err) {
        app.log.error(err, 'SSE polling error');
        clearInterval(interval);
        reply.raw.end();
      }
    }, 1000);

    req.raw.on('close', () => {
      clearInterval(interval);
    });
  });

  // Confirm a pending tool call
  app.post<{ Params: { id: string } }>('/api/runs/:id/confirm', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { id } = req.params;
    const body = confirmRunSchema.parse(req.body);
    const db = getDb();

    const [run] = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
    if (!run) {
      return reply.status(404).send({ error: 'Run not found' });
    }
    if (run.userId !== userId) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    if (run.status !== 'waiting' || run.wakeReason !== 'tool_confirm') {
      return reply.status(409).send({ error: 'Run is not awaiting confirmation' });
    }

    const [requestStep] = await db
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, id), eq(runSteps.type, 'tool_confirm_request')))
      .orderBy(desc(runSteps.seq))
      .limit(1);
    if (!requestStep) {
      return reply.status(409).send({ error: 'No pending confirmation request' });
    }
    const requestId = (requestStep.resultJson as { requestId?: string } | null)?.requestId;
    if (body.requestId && requestId && body.requestId !== requestId) {
      return reply.status(409).send({ error: 'Confirmation request ID mismatch' });
    }

    const [lastStep] = await db
      .select({ seq: runSteps.seq })
      .from(runSteps)
      .where(eq(runSteps.runId, id))
      .orderBy(desc(runSteps.seq))
      .limit(1);
    const nextSeq = lastStep ? lastStep.seq + 1 : 0;

    await db.insert(runSteps).values({
      runId: id,
      seq: nextSeq,
      type: 'tool_confirm',
      resultJson: {
        requestId: requestId ?? null,
        decision: body.decision,
        message: body.message ?? null,
        decidedAt: new Date().toISOString(),
      },
      status: 'completed',
      idempotencyKey: `${id}:tool_confirm:${nextSeq}`,
    });

    await db
      .update(runs)
      .set({
        status: 'pending',
        wakeReason: 'tool_confirm',
        updatedAt: new Date(),
      })
      .where(eq(runs.id, id));

    await enqueueRun({
      type: 'run',
      runId: id,
      tenantId: run.tenantId,
      agentId: run.agentId,
    });

    return { status: 'pending', decision: body.decision };
  });
}
