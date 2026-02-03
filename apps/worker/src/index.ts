import { Worker } from 'bullmq';
import pino from 'pino';
import { config } from './config.js';
import { processRun } from './run-processor.js';
import type { RunJob, MessageJob, DeliveryAckJob, MemoryWriteJob } from '@clifford/sdk';
import { processMessage } from './message-processor.js';
import { processDeliveryAck } from './delivery-ack-processor.js';
import { processMemoryWrite } from './memory-write-processor.js';

const logger = pino({ level: config.logLevel });

const connection = {
  url: config.redisUrl,
};

const runWorker = new Worker<RunJob>(
  'clifford-runs',
  async (job) => {
    await processRun(job, logger);
  },
  {
    connection,
    concurrency: config.workerConcurrency,
  }
);

const messageWorker = new Worker<MessageJob>(
  'clifford-messages',
  async (job) => {
    await processMessage(job, logger);
  },
  {
    connection,
    concurrency: config.workerConcurrency,
  }
);

const deliveryAckWorker = new Worker<DeliveryAckJob>(
  'clifford-delivery-acks',
  async (job) => {
    await processDeliveryAck(job, logger);
  },
  {
    connection,
    concurrency: config.workerConcurrency,
  }
);

const memoryWriteWorker = new Worker<MemoryWriteJob>(
  'clifford-memory-writes',
  async (job) => {
    return await processMemoryWrite(job, logger);
  },
  {
    connection,
    concurrency: config.workerConcurrency,
  }
);

runWorker.on('completed', (job) => {
  logger.info({ jobId: job.id }, 'Job completed');
});

runWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err }, 'Job failed');
});

messageWorker.on('completed', (job) => {
  logger.info({ jobId: job.id }, 'Message job completed');
});

messageWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err }, 'Message job failed');
});

deliveryAckWorker.on('completed', (job) => {
  logger.info({ jobId: job.id }, 'Delivery ack completed');
});

deliveryAckWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err }, 'Delivery ack failed');
});

memoryWriteWorker.on('completed', (job) => {
  logger.info({ jobId: job.id }, 'Memory write completed');
});

memoryWriteWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err }, 'Memory write failed');
});

logger.info(
  { concurrency: config.workerConcurrency },
  'Worker started, listening for jobs on clifford-runs'
);
logger.info(
  { concurrency: config.workerConcurrency },
  'Worker started, listening for jobs on clifford-messages'
);
logger.info(
  { concurrency: config.workerConcurrency },
  'Worker started, listening for jobs on clifford-delivery-acks'
);
logger.info(
  { concurrency: config.workerConcurrency },
  'Worker started, listening for jobs on clifford-memory-writes'
);

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down');
  await runWorker.close();
  await messageWorker.close();
  await deliveryAckWorker.close();
  await memoryWriteWorker.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down');
  await runWorker.close();
  await messageWorker.close();
  await deliveryAckWorker.close();
  await memoryWriteWorker.close();
  process.exit(0);
});
