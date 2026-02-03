import { Queue } from 'bullmq';
import type { DeliveryJob, DeliveryAckJob } from '@clifford/sdk';
import { config } from './config.js';

const connection = {
  url: config.redisUrl,
};

export const deliveryQueue = new Queue<DeliveryJob>('clifford-deliveries', { connection });
export const deliveryAckQueue = new Queue<DeliveryAckJob>('clifford-delivery-acks', { connection });

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
