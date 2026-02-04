import type { Job } from 'bullmq';
import type { WakeJob, Logger } from '@clifford/sdk';
import { getDb, runs } from '@clifford/db';
import { eq } from 'drizzle-orm';
import { enqueueRun } from './queues.js';

export async function processWake(job: Job<WakeJob>, logger: Logger) {
  const { runId, agentId, tenantId } = job.data;
  if (!runId) {
    logger.warn({ jobId: job.id }, 'Wake job missing runId');
    return;
  }

  const db = getDb();
  const [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!run) {
    logger.warn({ runId }, 'Wake run not found');
    return;
  }

  if (run.status !== 'waiting') {
    logger.info({ runId, status: run.status }, 'Wake ignored; run not waiting');
    return;
  }

  await db
    .update(runs)
    .set({ status: 'pending', wakeAt: null, wakeReason: null, updatedAt: new Date() })
    .where(eq(runs.id, runId));

  await enqueueRun({
    type: 'run',
    runId,
    tenantId: tenantId || run.tenantId,
    agentId: agentId || run.agentId,
  });

  logger.info({ runId }, 'Run woken and enqueued');
}
