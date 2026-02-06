import type { Job } from 'bullmq';
import type { Logger, RunJob } from '@clifford/sdk';
import { processRun } from '../run-processor.js';

export function createRunJob(logger: Logger) {
  return async (job: Job<RunJob>) => await processRun(job, logger);
}
