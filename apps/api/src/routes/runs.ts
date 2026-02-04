import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, runs, runSteps, agents, channels } from '@clifford/db';
import { eq, desc, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { enqueueRun } from '../queue.js';

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
        inputText: runs.inputText,
        outputText: runs.outputText,
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
        inputText: runs.inputText,
        outputText: runs.outputText,
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
}
