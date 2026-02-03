import type { FastifyInstance } from 'fastify';
import { messageQueue, runQueue, deliveryQueue } from '../queue.js';

const JOB_LIMIT = 25;

function serializeJob(job: any) {
  return {
    id: job.id,
    name: job.name,
    data: job.data,
    timestamp: job.timestamp,
    processedOn: job.processedOn,
    finishedOn: job.finishedOn,
    failedReason: job.failedReason,
  };
}

export async function queueRoutes(app: FastifyInstance) {
  app.get('/api/queue/status', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const [runCounts, messageCounts, deliveryCounts] = await Promise.all([
      runQueue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'),
      messageQueue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'),
      deliveryQueue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'),
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
    ]);

    return {
      queues: {
        runs: {
          counts: runCounts,
          active: runActive.map(serializeJob),
          waiting: runWaiting.map(serializeJob),
          completed: runCompleted.map(serializeJob),
          failed: runFailed.map(serializeJob),
        },
        messages: {
          counts: messageCounts,
          active: messageActive.map(serializeJob),
          waiting: messageWaiting.map(serializeJob),
          completed: messageCompleted.map(serializeJob),
          failed: messageFailed.map(serializeJob),
        },
        deliveries: {
          counts: deliveryCounts,
          active: deliveryActive.map(serializeJob),
          waiting: deliveryWaiting.map(serializeJob),
          completed: deliveryCompleted.map(serializeJob),
          failed: deliveryFailed.map(serializeJob),
        },
      },
    };
  });
}
