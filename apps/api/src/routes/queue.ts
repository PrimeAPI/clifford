import type { FastifyInstance } from 'fastify';
import { messageQueue, runQueue, deliveryQueue, memoryWriteQueue } from '../queue.js';
import { getDb, messages, channels, contexts } from '@clifford/db';
import { eq, inArray } from 'drizzle-orm';

const JOB_LIMIT = 25;

function serializeJob(
  job: any,
  extra?: { detail?: string; meta?: Record<string, unknown> }
) {
  return {
    id: job.id,
    name: job.name,
    data: job.data,
    timestamp: job.timestamp,
    processedOn: job.processedOn,
    finishedOn: job.finishedOn,
    failedReason: job.failedReason,
    result: job.returnvalue,
    detail: extra?.detail,
    meta: extra?.meta,
  };
}

export async function queueRoutes(app: FastifyInstance) {
  app.get('/api/queue/status', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const [runCounts, messageCounts, deliveryCounts, memoryCounts] = await Promise.all([
      runQueue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'),
      messageQueue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'),
      deliveryQueue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'),
      memoryWriteQueue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'),
    ]);

    const [
      runActive,
      runWaiting,
      runCompleted,
      runFailed,
      messageActive,
      messageWaiting,
      messageCompleted,
      messageFailed,
      deliveryActive,
      deliveryWaiting,
      deliveryCompleted,
      deliveryFailed,
      memoryActive,
      memoryWaiting,
      memoryCompleted,
      memoryFailed,
    ] = await Promise.all([
      runQueue.getJobs(['active'], 0, JOB_LIMIT - 1),
      runQueue.getJobs(['waiting'], 0, JOB_LIMIT - 1),
      runQueue.getJobs(['completed'], 0, JOB_LIMIT - 1),
      runQueue.getJobs(['failed'], 0, JOB_LIMIT - 1),
      messageQueue.getJobs(['active'], 0, JOB_LIMIT - 1),
      messageQueue.getJobs(['waiting'], 0, JOB_LIMIT - 1),
      messageQueue.getJobs(['completed'], 0, JOB_LIMIT - 1),
      messageQueue.getJobs(['failed'], 0, JOB_LIMIT - 1),
      deliveryQueue.getJobs(['active'], 0, JOB_LIMIT - 1),
      deliveryQueue.getJobs(['waiting'], 0, JOB_LIMIT - 1),
      deliveryQueue.getJobs(['completed'], 0, JOB_LIMIT - 1),
      deliveryQueue.getJobs(['failed'], 0, JOB_LIMIT - 1),
      memoryWriteQueue.getJobs(['active'], 0, JOB_LIMIT - 1),
      memoryWriteQueue.getJobs(['waiting'], 0, JOB_LIMIT - 1),
      memoryWriteQueue.getJobs(['completed'], 0, JOB_LIMIT - 1),
      memoryWriteQueue.getJobs(['failed'], 0, JOB_LIMIT - 1),
    ]);

    const db = getDb();
    const messageMeta = await buildMessageMeta(db, [
      ...messageActive,
      ...messageWaiting,
      ...messageCompleted,
      ...messageFailed,
    ]);

    const memoryMeta = await buildMemoryMeta(db, [
      ...memoryActive,
      ...memoryWaiting,
      ...memoryCompleted,
      ...memoryFailed,
    ]);

    return {
      queues: {
        runs: {
          counts: runCounts,
          active: runActive.map((job) => serializeJob(job)),
          waiting: runWaiting.map((job) => serializeJob(job)),
          completed: runCompleted.map((job) => serializeJob(job)),
          failed: runFailed.map((job) => serializeJob(job)),
        },
        messages: {
          counts: messageCounts,
          active: messageActive.map((job) =>
            serializeJob(job, messageMeta.get(job.id) ?? undefined)
          ),
          waiting: messageWaiting.map((job) =>
            serializeJob(job, messageMeta.get(job.id) ?? undefined)
          ),
          completed: messageCompleted.map((job) =>
            serializeJob(job, messageMeta.get(job.id) ?? undefined)
          ),
          failed: messageFailed.map((job) =>
            serializeJob(job, messageMeta.get(job.id) ?? undefined)
          ),
        },
        deliveries: {
          counts: deliveryCounts,
          active: deliveryActive.map((job) => serializeJob(job)),
          waiting: deliveryWaiting.map((job) => serializeJob(job)),
          completed: deliveryCompleted.map((job) => serializeJob(job)),
          failed: deliveryFailed.map((job) => serializeJob(job)),
        },
        memoryWrites: {
          counts: memoryCounts,
          active: memoryActive.map((job) =>
            serializeJob(job, memoryMeta.get(job.id) ?? undefined)
          ),
          waiting: memoryWaiting.map((job) =>
            serializeJob(job, memoryMeta.get(job.id) ?? undefined)
          ),
          completed: memoryCompleted.map((job) =>
            serializeJob(job, memoryMeta.get(job.id) ?? undefined)
          ),
          failed: memoryFailed.map((job) =>
            serializeJob(job, memoryMeta.get(job.id) ?? undefined)
          ),
        },
      },
    };
  });
}

async function buildMessageMeta(db: ReturnType<typeof getDb>, jobs: any[]) {
  const messageIds = jobs
    .map((job) => job?.data?.messageId)
    .filter((id): id is string => Boolean(id));

  if (messageIds.length === 0) {
    return new Map<string, { detail: string; meta: Record<string, unknown> }>();
  }

  const rows = await db
    .select({
      id: messages.id,
      channelId: messages.channelId,
      contextId: messages.contextId,
      content: messages.content,
      direction: messages.direction,
      channelName: channels.name,
      contextName: contexts.name,
    })
    .from(messages)
    .leftJoin(channels, eq(messages.channelId, channels.id))
    .leftJoin(contexts, eq(messages.contextId, contexts.id))
    .where(inArray(messages.id, messageIds));

  const meta = new Map<string, { detail: string; meta: Record<string, unknown> }>();
  for (const row of rows) {
    meta.set(row.id, {
      detail: `${row.direction === 'inbound' ? 'User' : 'Assistant'}: ${row.content}`,
      meta: {
        channelId: row.channelId,
        channelName: row.channelName,
        contextId: row.contextId,
        contextName: row.contextName,
        source: 'chat',
      },
    });
  }

  return meta;
}

async function buildMemoryMeta(db: ReturnType<typeof getDb>, jobs: any[]) {
  const contextIds = jobs
    .map((job) => job?.data?.contextId)
    .filter((id): id is string => Boolean(id));

  if (contextIds.length === 0) {
    return new Map<string, { detail: string; meta: Record<string, unknown> }>();
  }

  const rows = await db
    .select({
      id: contexts.id,
      name: contexts.name,
      channelId: contexts.channelId,
      channelName: channels.name,
    })
    .from(contexts)
    .leftJoin(channels, eq(contexts.channelId, channels.id))
    .where(inArray(contexts.id, contextIds));

  const byContextId = new Map<string, { contextName: string | null; channelId: string | null; channelName: string | null }>();
  for (const row of rows) {
    byContextId.set(row.id, {
      contextName: row.name ?? null,
      channelId: row.channelId ?? null,
      channelName: row.channelName ?? null,
    });
  }

  const meta = new Map<string, { detail: string; meta: Record<string, unknown> }>();
  for (const job of jobs) {
    const contextId = job?.data?.contextId as string | undefined;
    const mode = job?.data?.mode as string | undefined;
    const contextInfo = contextId ? byContextId.get(contextId) : null;
    const detail = mode ? `Memory write (${mode})` : 'Memory write';
    meta.set(job.id, {
      detail,
      meta: {
        contextId,
        contextName: contextInfo?.contextName ?? null,
        channelId: contextInfo?.channelId ?? null,
        channelName: contextInfo?.channelName ?? null,
        source: mode === 'compact' ? 'compaction' : 'context_close',
      },
    });
  }

  return meta;
}
