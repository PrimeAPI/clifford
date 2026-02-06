import type { Job } from 'bullmq';
import type { Logger, DeliveryAckJob } from '@clifford/sdk';
import { processDeliveryAck } from '../delivery-ack-processor.js';

export function createDeliveryAckJob(logger: Logger) {
  return async (job: Job<DeliveryAckJob>) => await processDeliveryAck(job, logger);
}
