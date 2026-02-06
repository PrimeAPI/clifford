import { Worker } from 'bullmq';
import pino from 'pino';
import { config } from './config.js';
import { processRun } from './run-processor.js';
import type { RunJob, MessageJob, DeliveryAckJob, MemoryWriteJob, WakeJob } from '@clifford/sdk';
import { processMessage } from './message-processor.js';
import { processDeliveryAck } from './delivery-ack-processor.js';
import { processMemoryWrite } from './memory-write-processor.js';
import { processWake } from './wake-processor.js';
import {
  QUEUE_DELIVERY_ACKS,
  QUEUE_MEMORY_WRITES,
  QUEUE_MESSAGES,
  QUEUE_RUNS,
  QUEUE_WAKE,
} from '@clifford/core';

const logger = pino({ level: config.logLevel });

const connection = {
  url: config.redisUrl,
};

const runWorker = new Worker<RunJob>(
  QUEUE_RUNS,
  async (job) => {
    await processRun(job, logger);
  },
  {
    connection,
    concurrency: config.workerConcurrency,
  }
);

const messageWorker = new Worker<MessageJob>(
  QUEUE_MESSAGES,
  async (job) => {
    await processMessage(job, logger);
  },
  {
    connection,
    concurrency: config.workerConcurrency,
  }
);

const deliveryAckWorker = new Worker<DeliveryAckJob>(
  QUEUE_DELIVERY_ACKS,
  async (job) => {
    await processDeliveryAck(job, logger);
  },
  {
    connection,
    concurrency: config.workerConcurrency,
  }
);

const memoryWriteWorker = new Worker<MemoryWriteJob>(
  QUEUE_MEMORY_WRITES,
  async (job) => {
    return await processMemoryWrite(job, logger);
  },
  {
    connection,
    concurrency: config.workerConcurrency,
  }
);

const wakeWorker = new Worker<WakeJob>(
  QUEUE_WAKE,
  async (job) => {
    return await processWake(job, logger);
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

wakeWorker.on('completed', (job) => {
  logger.info({ jobId: job.id }, 'Wake job completed');
});

wakeWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err }, 'Wake job failed');
});

logger.info(
  { concurrency: config.workerConcurrency },
  `Worker started, listening for jobs on ${QUEUE_RUNS}`
);
logger.info(
  { concurrency: config.workerConcurrency },
  `Worker started, listening for jobs on ${QUEUE_MESSAGES}`
);
logger.info(
  { concurrency: config.workerConcurrency },
  `Worker started, listening for jobs on ${QUEUE_DELIVERY_ACKS}`
);
logger.info(
  { concurrency: config.workerConcurrency },
  `Worker started, listening for jobs on ${QUEUE_MEMORY_WRITES}`
);
logger.info(
  { concurrency: config.workerConcurrency },
  `Worker started, listening for jobs on ${QUEUE_WAKE}`
);

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down');
  await runWorker.close();
  await messageWorker.close();
  await deliveryAckWorker.close();
  await memoryWriteWorker.close();
  await wakeWorker.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down');
  await runWorker.close();
  await messageWorker.close();
  await deliveryAckWorker.close();
  await memoryWriteWorker.close();
  await wakeWorker.close();
  process.exit(0);
});
