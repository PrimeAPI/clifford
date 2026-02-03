import { Worker } from 'bullmq';
import pino from 'pino';
import { config } from './config.js';
import { processRun } from './run-processor.js';
import type { RunJob } from '@clifford/sdk';

const logger = pino({ level: config.logLevel });

const connection = {
  url: config.redisUrl,
};

const worker = new Worker<RunJob>(
  'clifford:runs',
  async (job) => {
    await processRun(job, logger);
  },
  {
    connection,
    concurrency: config.workerConcurrency,
  }
);

worker.on('completed', (job) => {
  logger.info({ jobId: job.id }, 'Job completed');
});

worker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err }, 'Job failed');
});

logger.info(
  { concurrency: config.workerConcurrency },
  'Worker started, listening for jobs on clifford:runs'
);

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down');
  await worker.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down');
  await worker.close();
  process.exit(0);
});
