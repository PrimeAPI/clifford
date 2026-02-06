import type { Job } from 'bullmq';
import type { Logger, WakeJob } from '@clifford/sdk';
import { processWake } from '../wake-processor.js';

export function createWakeJob(logger: Logger) {
  return async (job: Job<WakeJob>) => await processWake(job, logger);
}
