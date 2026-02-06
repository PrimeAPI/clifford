import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { config } from '../config.js';

type Processor<T> = (job: Job<T>) => Promise<unknown>;

type WorkerFactoryOptions = {
  concurrency?: number;
};

export class WorkerFactory {
  private readonly connection = { url: config.redisUrl };
  private readonly concurrency: number;

  constructor(private readonly logger: Logger, options: WorkerFactoryOptions = {}) {
    this.concurrency = options.concurrency ?? config.workerConcurrency;
  }

  createWorker<T>(queueName: string, processor: Processor<T>) {
    const worker = new Worker<T>(
      queueName,
      async (job) => await processor(job),
      {
        connection: this.connection,
        concurrency: this.concurrency,
      }
    );

    worker.on('completed', (job) => {
      this.logger.info({ jobId: job.id, queue: queueName }, 'Job completed');
    });

    worker.on('failed', (job, err) => {
      this.logger.error({ jobId: job?.id, err, queue: queueName }, 'Job failed');
    });

    return worker;
  }
}
