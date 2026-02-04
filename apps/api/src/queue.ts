import { Queue } from 'bullmq';
import type { RunJob, MessageJob, DeliveryJob, MemoryWriteJob } from '@clifford/sdk';
import { config } from './config.js';

const connection = {
  url: config.redisUrl,
};

export const runQueue = new Queue<RunJob>('clifford-runs', { connection });
export const messageQueue = new Queue<MessageJob>('clifford-messages', { connection });
export const deliveryQueue = new Queue<DeliveryJob>('clifford-deliveries', { connection });
export const memoryWriteQueue = new Queue<MemoryWriteJob>('clifford-memory-writes', {
  connection,
});

export async function enqueueRun(job: RunJob) {
  await runQueue.add('run', job, {
    removeOnComplete: 100,
    removeOnFail: 500,
  });
}

export async function enqueueMessage(job: MessageJob) {
  await messageQueue.add('message', job, {
    jobId: job.messageId,
    removeOnComplete: 100,
    removeOnFail: 500,
  });
}

export async function enqueueDelivery(job: DeliveryJob) {
  await deliveryQueue.add('delivery', job, {
    jobId: job.messageId,
    removeOnComplete: 100,
    removeOnFail: 500,
  });
}

export async function enqueueMemoryWrite(job: MemoryWriteJob) {
  await memoryWriteQueue.add('memory_write', job, {
    removeOnComplete: 100,
    removeOnFail: 500,
  });
}
