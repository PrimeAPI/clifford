import type { FastifyInstance } from 'fastify';
import { getDb, runs, runSteps } from '@clifford/db';
import { eq } from 'drizzle-orm';
import { enqueueRun } from '../../queue.js';
import { createRunSchema, listRunsQuerySchema } from './runs.schema.js';
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
}
