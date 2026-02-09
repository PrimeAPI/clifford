import type { FastifyInstance } from 'fastify';
import { messageQueue, runQueue, deliveryQueue, memoryWriteQueue } from '../../queue.js';
import { getDb } from '@clifford/db';
import { buildMemoryMeta, buildMessageMeta, JOB_LIMIT, serializeJob } from './queue.service.js';

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
            serializeJob(job, messageMeta.get(job.id!) ?? undefined)
          ),
          waiting: messageWaiting.map((job) =>
            serializeJob(job, messageMeta.get(job.id!) ?? undefined)
          ),
          completed: messageCompleted.map((job) =>
            serializeJob(job, messageMeta.get(job.id!) ?? undefined)
          ),
          failed: messageFailed.map((job) =>
            serializeJob(job, messageMeta.get(job.id!) ?? undefined)
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
          active: memoryActive.map((job) => serializeJob(job, memoryMeta.get(job.id!) ?? undefined)),
          waiting: memoryWaiting.map((job) =>
            serializeJob(job, memoryMeta.get(job.id!) ?? undefined)
          ),
          completed: memoryCompleted.map((job) =>
            serializeJob(job, memoryMeta.get(job.id!) ?? undefined)
          ),
          failed: memoryFailed.map((job) => serializeJob(job, memoryMeta.get(job.id!) ?? undefined)),
        },
      },
    };
  });
}
