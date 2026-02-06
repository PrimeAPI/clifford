import { Queue } from 'bullmq';
import pino from 'pino';
import { getDb, triggers, contexts, runs, runSteps } from '@clifford/db';
import { lte, eq, and, isNull, inArray } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import type { WakeJob, MemoryWriteJob } from '@clifford/sdk';
import { config } from './config.js';
import cronParser from 'cron-parser';

const logger = pino({ level: config.logLevel });

const connection = {
  url: config.redisUrl,
};

const wakeQueue = new Queue<WakeJob>('clifford-wake', { connection });
const memoryWriteQueue = new Queue<MemoryWriteJob>('clifford-memory-writes', { connection });

function nextCronFireAt(cron: string, now: Date) {
  const interval = cronParser.parseExpression(cron, { currentDate: now });
  const next = interval.next().toDate();
  return next;
}

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
    const spec = trigger.specJson as { every_seconds?: number; cron?: string; runId?: string };
    await wakeQueue.add('wake', {
      type: 'wake',
      triggerId: trigger.id,
      tenantId: '', // TODO: get from agent
      agentId: trigger.agentId,
      runId: spec?.runId,
    });

    // Calculate next fire time
    if (trigger.type === 'interval' && spec.every_seconds) {
      const nextFireAt = new Date(now.getTime() + spec.every_seconds * 1000);
      await db.update(triggers).set({ nextFireAt }).where(eq(triggers.id, trigger.id));
      logger.info({ triggerId: trigger.id, nextFireAt }, 'Trigger rescheduled');
    } else if (trigger.type === 'cron' && spec.cron) {
      const nextFireAt = nextCronFireAt(spec.cron, now);
      await db.update(triggers).set({ nextFireAt }).where(eq(triggers.id, trigger.id));
      logger.info({ triggerId: trigger.id, nextFireAt }, 'Cron trigger rescheduled');
    } else if (trigger.type === 'run_wake') {
      await db
        .update(triggers)
        .set({ enabled: false, nextFireAt: null })
        .where(eq(triggers.id, trigger.id));
      logger.info({ triggerId: trigger.id }, 'Run wake trigger disabled');
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

async function wakeWaitingParents() {
  const db = getDb();
  const parents = await db
    .select({
      id: runs.id,
      agentId: runs.agentId,
      tenantId: runs.tenantId,
    })
    .from(runs)
    .where(eq(runs.status, 'waiting'))
    .limit(200);

  for (const parent of parents) {
    const children = await db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.parentRunId, parent.id),
          inArray(runs.status, ['completed', 'failed'])
        )
      )
      .limit(1);
    if (children.length === 0) continue;
    await wakeQueue.add('wake', {
      type: 'wake',
      triggerId: '',
      tenantId: parent.tenantId,
      agentId: parent.agentId,
      runId: parent.id,
    });
    await db.insert(runSteps).values({
      runId: parent.id,
      seq: Date.now(),
      type: 'message',
      resultJson: { event: 'parent_wake_queued', source: 'daemon' },
      status: 'completed',
      idempotencyKey: randomUUID(),
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

  setInterval(async () => {
    try {
      await wakeWaitingParents();
    } catch (err) {
      logger.error({ err }, 'Wake waiting parents failed');
    }
  }, 60_000);
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
