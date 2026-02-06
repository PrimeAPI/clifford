import { Queue } from 'bullmq';
import type { DeliveryJob, DeliveryAckJob, MemoryWriteJob, RunJob } from '@clifford/sdk';
import { config } from './config.js';
import {
  QUEUE_DELIVERIES,
  QUEUE_DELIVERY_ACKS,
  QUEUE_MEMORY_WRITES,
  QUEUE_RUNS,
} from '@clifford/core';

const connection = {
  url: config.redisUrl,
};

export const deliveryQueue = new Queue<DeliveryJob>(QUEUE_DELIVERIES, { connection });
export const deliveryAckQueue = new Queue<DeliveryAckJob>(QUEUE_DELIVERY_ACKS, { connection });
export const memoryWriteQueue = new Queue<MemoryWriteJob>(QUEUE_MEMORY_WRITES, { connection });
export const runQueue = new Queue<RunJob>(QUEUE_RUNS, { connection });

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
    removeOnComplete: 100,
    removeOnFail: 500,
    delay: delayMs && delayMs > 0 ? delayMs : undefined,
  });
}
