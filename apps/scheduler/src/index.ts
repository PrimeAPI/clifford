import { Queue } from 'bullmq';
import pino from 'pino';
import { getDb, triggers, contexts } from '@clifford/db';
import { lte, eq, and, isNull } from 'drizzle-orm';
import type { WakeJob, MemoryWriteJob } from '@clifford/sdk';
import { config } from './config.js';

const logger = pino({ level: config.logLevel });

const connection = {
  url: config.redisUrl,
};

const wakeQueue = new Queue<WakeJob>('clifford-wake', { connection });
const memoryWriteQueue = new Queue<MemoryWriteJob>('clifford-memory-writes', { connection });

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

async function autoCloseContexts() {
  const db = getDb();
  const now = new Date();
  const cutoff = new Date(
    now.getTime() - config.autoCloseInactivityHours * 60 * 60 * 1000
  );

  const stale = await db
    .select()
    .from(contexts)
    .where(and(isNull(contexts.closedAt), lte(contexts.lastUserInteractionAt, cutoff)))
    .limit(100);

  for (const context of stale) {
    await db
      .update(contexts)
      .set({ closedAt: now, updatedAt: now })
      .where(eq(contexts.id, context.id));

    await memoryWriteQueue.add('memory_write', {
      type: 'memory_write',
      contextId: context.id,
      userId: context.userId,
      mode: 'close',
    });
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

  setInterval(async () => {
    try {
      await autoCloseContexts();
    } catch (err) {
      logger.error({ err }, 'Auto-close failed');
    }
  }, config.autoCloseIntervalMs);
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
