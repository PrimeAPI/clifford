import { Queue } from 'bullmq';
import type { RunJob } from '@clifford/sdk';
import { config } from './config.js';

const connection = {
  url: config.redisUrl,
};

export const runQueue = new Queue<RunJob>('clifford-runs', { connection });

export async function enqueueRun(job: RunJob) {
  await runQueue.add('run', job, {
    jobId: job.runId,
    removeOnComplete: 100,
    removeOnFail: 500,
  });
}
