import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, runs, runSteps, agents, channels, messages } from '@clifford/db';
import { eq, desc, sql, and, inArray } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { enqueueRun, enqueueDelivery } from '../queue.js';

const createRunSchema = z.object({
  agentId: z.string().uuid(),
  channelId: z.string().uuid(),
  contextId: z.string().uuid().optional(),
  inputText: z.string().min(1),
});

const listRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

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
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(runs)
      .where(eq(runs.tenantId, tenantId));
    const total = Number(count ?? 0);

    const recentRuns = await db
      .select({
        id: runs.id,
        agentId: runs.agentId,
        agentName: agents.name,
        channelId: runs.channelId,
        userId: runs.userId,
        contextId: runs.contextId,
        parentRunId: runs.parentRunId,
        rootRunId: runs.rootRunId,
        kind: runs.kind,
        profile: runs.profile,
        inputText: runs.inputText,
        inputJson: runs.inputJson,
        outputText: runs.outputText,
        allowedTools: runs.allowedTools,
        wakeAt: runs.wakeAt,
        wakeReason: runs.wakeReason,
        status: runs.status,
        createdAt: runs.createdAt,
        updatedAt: runs.updatedAt,
      })
      .from(runs)
      .leftJoin(agents, eq(runs.agentId, agents.id))
      .where(eq(runs.tenantId, tenantId))
      .orderBy(desc(runs.createdAt))
      .limit(limit)
      .offset(offset);

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

    const [channel] = await db
      .select()
      .from(channels)
      .where(eq(channels.id, body.channelId))
      .limit(1);

    if (!channel || channel.userId !== userId) {
      return reply.status(404).send({ error: 'Channel not found' });
    }

    const runId = randomUUID();
    await db.insert(runs).values({
      id: runId,
      tenantId,
      agentId: body.agentId,
      userId,
      channelId: body.channelId,
      contextId: body.contextId ?? null,
      kind: 'coordinator',
      rootRunId: runId,
      inputText: body.inputText,
      outputText: '',
      status: 'pending',
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

    const run = await db
      .select({
        id: runs.id,
        agentId: runs.agentId,
        agentName: agents.name,
        channelId: runs.channelId,
        userId: runs.userId,
        contextId: runs.contextId,
        parentRunId: runs.parentRunId,
        rootRunId: runs.rootRunId,
        kind: runs.kind,
        profile: runs.profile,
        inputText: runs.inputText,
        inputJson: runs.inputJson,
        outputText: runs.outputText,
        allowedTools: runs.allowedTools,
        wakeAt: runs.wakeAt,
        wakeReason: runs.wakeReason,
        status: runs.status,
        createdAt: runs.createdAt,
        updatedAt: runs.updatedAt,
      })
      .from(runs)
      .leftJoin(agents, eq(runs.agentId, agents.id))
      .where(eq(runs.id, id))
      .limit(1);
    if (run.length === 0) {
      return reply.status(404).send({ error: 'Run not found' });
    }

    const steps = await db
      .select()
      .from(runSteps)
      .where(eq(runSteps.runId, id))
      .orderBy(runSteps.seq);

    return {
      run: run[0],
      steps,
    };
  });

  // List subagent runs for a coordinator
  app.get<{ Params: { id: string } }>('/api/runs/:id/children', async (req, reply) => {
    const { id } = req.params;
    const db = getDb();

    const children = await db
      .select({
        id: runs.id,
        agentId: runs.agentId,
        agentName: agents.name,
        channelId: runs.channelId,
        userId: runs.userId,
        contextId: runs.contextId,
        parentRunId: runs.parentRunId,
        rootRunId: runs.rootRunId,
        kind: runs.kind,
        profile: runs.profile,
        inputText: runs.inputText,
        inputJson: runs.inputJson,
        outputText: runs.outputText,
        allowedTools: runs.allowedTools,
        wakeAt: runs.wakeAt,
        wakeReason: runs.wakeReason,
        status: runs.status,
        createdAt: runs.createdAt,
        updatedAt: runs.updatedAt,
      })
      .from(runs)
      .leftJoin(agents, eq(runs.agentId, agents.id))
      .where(eq(runs.parentRunId, id))
      .orderBy(desc(runs.createdAt));

    return { children };
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

  // Cancel a run (and its descendants)
  app.post<{ Params: { id: string } }>('/api/runs/:id/cancel', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(400).send({ error: 'Missing X-User-Id header' });
    }
    const { id } = req.params;
    const db = getDb();
    const [run] = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
    if (!run) {
      return reply.status(404).send({ error: 'Run not found' });
    }
    if (run.userId && run.userId !== userId) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const rootId = run.rootRunId ?? run.id;
    const now = new Date();
    await db
      .update(runs)
      .set({ status: 'cancelled', updatedAt: now, outputText: 'This task was cancelled.' })
      .where(and(eq(runs.rootRunId, rootId), inArray(runs.status, ['pending', 'running', 'waiting'])));
    await db
      .update(runs)
      .set({ status: 'cancelled', updatedAt: now, outputText: 'This task was cancelled.' })
      .where(and(eq(runs.id, rootId), inArray(runs.status, ['pending', 'running', 'waiting'])));

    await db.insert(runSteps).values({
      runId: run.id,
      seq: Date.now(),
      type: 'message',
      resultJson: { event: 'cancelled', reason: 'user_cancelled' },
      status: 'completed',
      idempotencyKey: randomUUID(),
    });

    const [channel] = await db
      .select()
      .from(channels)
      .where(eq(channels.id, run.channelId))
      .limit(1);
    if (channel && run.userId) {
      const [outbound] = await db
        .insert(messages)
        .values({
          id: randomUUID(),
          userId: run.userId,
          channelId: run.channelId,
          contextId: run.contextId ?? null,
          content: 'This task was cancelled.',
          direction: 'outbound',
          deliveryStatus: channel.type === 'web' ? 'delivered' : 'pending',
          deliveredAt: channel.type === 'web' ? now : null,
          metadata: JSON.stringify({
            source: 'run',
            runId: run.id,
            kind: run.kind,
            cancelled: true,
          }),
        })
        .returning();
      const outboundId = outbound?.id ?? null;
      if (channel.type === 'discord' && outboundId) {
        const configValue = channel.config as { discordUserId?: string } | null;
        if (configValue?.discordUserId) {
          await enqueueDelivery({
            type: 'delivery',
            provider: 'discord',
            messageId: outboundId,
            payload: {
              discordUserId: configValue.discordUserId,
              content: 'This task was cancelled.',
            },
          });
        }
      }
    }

    return { status: 'cancelled', runId: run.id };
  });
}
