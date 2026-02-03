import { Queue } from 'bullmq';
import pino from 'pino';
import { getDb, triggers } from '@clifford/db';
import { lte, eq } from 'drizzle-orm';
import type { WakeJob } from '@clifford/sdk';
import { config } from './config.js';

const logger = pino({ level: config.logLevel });

const connection = {
  url: config.redisUrl,
};

const wakeQueue = new Queue<WakeJob>('clifford-wake', { connection });

async function tick() {
  const db = getDb();
  const now = new Date();

  // Find triggers that are due
  const due = await db
    .select()
    .from(triggers)
    .where(lte(triggers.nextFireAt, now))
    .limit(100);

  for (const trigger of due) {
    if (!trigger.enabled) continue;

    logger.info({ triggerId: trigger.id }, 'Firing trigger');

    // Enqueue wake job
    await wakeQueue.add('wake', {
      type: 'wake',
      triggerId: trigger.id,
      tenantId: '', // TODO: get from agent
      agentId: trigger.agentId,
    });

    // Calculate next fire time
    const spec = trigger.specJson as { every_seconds?: number };
    if (trigger.type === 'interval' && spec.every_seconds) {
      const nextFireAt = new Date(now.getTime() + spec.every_seconds * 1000);
      await db.update(triggers).set({ nextFireAt }).where(eq(triggers.id, trigger.id));
      logger.info({ triggerId: trigger.id, nextFireAt }, 'Trigger rescheduled');
    }
  }
}

async function run() {
  logger.info({ intervalMs: config.schedulerIntervalMs }, 'Scheduler started');

  setInterval(async () => {
    try {
      await tick();
    } catch (err) {
      logger.error({ err }, 'Scheduler tick failed');
    }
  }, config.schedulerIntervalMs);
}

run();

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down');
  process.exit(0);
});
