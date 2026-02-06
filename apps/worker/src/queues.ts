import { Queue } from 'bullmq';
import type { DeliveryJob, DeliveryAckJob, MemoryWriteJob, RunJob } from '@clifford/sdk';
import { config } from './config.js';

const connection = {
  url: config.redisUrl,
};

export const deliveryQueue = new Queue<DeliveryJob>('clifford-deliveries', { connection });
export const deliveryAckQueue = new Queue<DeliveryAckJob>('clifford-delivery-acks', { connection });
export const memoryWriteQueue = new Queue<MemoryWriteJob>('clifford-memory-writes', { connection });
export const runQueue = new Queue<RunJob>('clifford-runs', { connection });

export async function enqueueDelivery(job: DeliveryJob) {
  await deliveryQueue.add('delivery', job, {
    jobId: job.messageId,
    removeOnComplete: 100,
    removeOnFail: 500,
  });
}

export async function enqueueDeliveryAck(job: DeliveryAckJob) {
  await deliveryAckQueue.add('delivery_ack', job, {
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

export async function enqueueRun(job: RunJob, delayMs?: number) {
  await runQueue.add('run', job, {
    jobId: job.runId,
    removeOnComplete: 100,
    removeOnFail: 500,
    delay: delayMs && delayMs > 0 ? delayMs : undefined,
  });
}

export async function enqueueRunWake(job: RunJob, delayMs?: number) {
  await runQueue.add('run', job, {
    jobId: `${job.runId}:wake:${Date.now()}`,
    removeOnComplete: 100,
    removeOnFail: 500,
    delay: delayMs && delayMs > 0 ? delayMs : undefined,
  });
}
