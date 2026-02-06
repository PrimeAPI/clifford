import type { Job } from 'bullmq';
import type { Logger, MemoryWriteJob } from '@clifford/sdk';
import { processMemoryWrite } from '../memory-write-processor.js';

export function createMemoryWriteJob(logger: Logger) {
  return async (job: Job<MemoryWriteJob>) => await processMemoryWrite(job, logger);
}
