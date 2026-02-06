import type { Job } from 'bullmq';
import type { Logger, MessageJob } from '@clifford/sdk';
import { processMessage } from '../message-processor.js';

export function createMessageJob(logger: Logger) {
  return async (job: Job<MessageJob>) => await processMessage(job, logger);
}
