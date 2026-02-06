import pino from 'pino';
import { config } from './config.js';
import { WorkerFactory } from './lib/worker-factory.js';
import { createRunJob } from './jobs/run.job.js';
import { createMessageJob } from './jobs/message.job.js';
import { createDeliveryAckJob } from './jobs/delivery-ack.job.js';
import { createMemoryWriteJob } from './jobs/memory-write.job.js';
import { createWakeJob } from './jobs/wake.job.js';
import {
  QUEUE_DELIVERY_ACKS,
  QUEUE_MEMORY_WRITES,
  QUEUE_MESSAGES,
  QUEUE_RUNS,
  QUEUE_WAKE,
} from '@clifford/core';

const logger = pino({ level: config.logLevel });
const factory = new WorkerFactory(logger);

const workerSpecs = [
  { queue: QUEUE_RUNS, processor: createRunJob(logger) },
  { queue: QUEUE_MESSAGES, processor: createMessageJob(logger) },
  { queue: QUEUE_DELIVERY_ACKS, processor: createDeliveryAckJob(logger) },
  { queue: QUEUE_MEMORY_WRITES, processor: createMemoryWriteJob(logger) },
  { queue: QUEUE_WAKE, processor: createWakeJob(logger) },
];

const workers = workerSpecs.map(({ queue, processor }) => factory.createWorker(queue, processor));

for (const { queue } of workerSpecs) {
  logger.info(
    { concurrency: config.workerConcurrency },
    `Worker started, listening for jobs on ${queue}`
  );
}

// Graceful shutdown
const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Shutdown signal received, shutting down');
  await Promise.all(workers.map((worker) => worker.close()));
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
