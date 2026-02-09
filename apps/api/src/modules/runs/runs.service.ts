import { getDb, runs, runSteps, agents, channels } from '@clifford/db';
import { eq, desc, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';

export async function listRunsForTenant(
  db: ReturnType<typeof getDb>,
  tenantId: string,
  limit: number,
  offset: number
) {
  const [countRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(runs)
    .where(eq(runs.tenantId, tenantId));
  const count = countRow?.count ?? 0;
  const total = Number(count ?? 0);

  const recentRuns = await db
    .select({
      id: runs.id,
      agentId: runs.agentId,
      agentName: agents.name,
      channelId: runs.channelId,
      userId: runs.userId,
      contextId: runs.contextId,
      parentRunId: runs.parentRunId,
      rootRunId: runs.rootRunId,
      kind: runs.kind,
      profile: runs.profile,
      inputText: runs.inputText,
      inputJson: runs.inputJson,
      outputText: runs.outputText,
      allowedTools: runs.allowedTools,
      wakeAt: runs.wakeAt,
      wakeReason: runs.wakeReason,
      status: runs.status,
      createdAt: runs.createdAt,
      updatedAt: runs.updatedAt,
    })
    .from(runs)
    .leftJoin(agents, eq(runs.agentId, agents.id))
    .where(eq(runs.tenantId, tenantId))
    .orderBy(desc(runs.createdAt))
    .limit(limit)
    .offset(offset);

  return { total, runs: recentRuns };
}

export async function ensureRunChannelAccess(db: ReturnType<typeof getDb>, channelId: string) {
  const [channel] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
  return channel ?? null;
}

export async function createRunRecord(
  db: ReturnType<typeof getDb>,
  payload: {
    tenantId: string;
    agentId: string;
    userId: string;
    channelId: string;
    contextId?: string | null;
    inputText: string;
  }
) {
  const runId = randomUUID();
  await db.insert(runs).values({
    id: runId,
    tenantId: payload.tenantId,
    agentId: payload.agentId,
    userId: payload.userId,
    channelId: payload.channelId,
    contextId: payload.contextId ?? null,
    kind: 'coordinator',
    rootRunId: runId,
    inputText: payload.inputText,
    outputText: '',
    status: 'pending',
  });

  return runId;
}

export async function getRunDetails(db: ReturnType<typeof getDb>, id: string) {
  const run = await db
    .select({
      id: runs.id,
      agentId: runs.agentId,
      agentName: agents.name,
      channelId: runs.channelId,
      userId: runs.userId,
      contextId: runs.contextId,
      parentRunId: runs.parentRunId,
      rootRunId: runs.rootRunId,
      kind: runs.kind,
      profile: runs.profile,
      inputText: runs.inputText,
      inputJson: runs.inputJson,
      outputText: runs.outputText,
      allowedTools: runs.allowedTools,
      wakeAt: runs.wakeAt,
      wakeReason: runs.wakeReason,
      status: runs.status,
      createdAt: runs.createdAt,
      updatedAt: runs.updatedAt,
    })
    .from(runs)
    .leftJoin(agents, eq(runs.agentId, agents.id))
    .where(eq(runs.id, id))
    .limit(1);

  if (run.length === 0) {
    return null;
  }

  const steps = await db
    .select()
    .from(runSteps)
    .where(eq(runSteps.runId, id))
    .orderBy(runSteps.seq);

  return { run: run[0], steps };
}

export async function listRunChildren(db: ReturnType<typeof getDb>, id: string) {
  const children = await db
    .select({
      id: runs.id,
      agentId: runs.agentId,
      agentName: agents.name,
      channelId: runs.channelId,
      userId: runs.userId,
      contextId: runs.contextId,
      parentRunId: runs.parentRunId,
      rootRunId: runs.rootRunId,
      kind: runs.kind,
      profile: runs.profile,
      inputText: runs.inputText,
      inputJson: runs.inputJson,
      outputText: runs.outputText,
      allowedTools: runs.allowedTools,
      wakeAt: runs.wakeAt,
      wakeReason: runs.wakeReason,
      status: runs.status,
      createdAt: runs.createdAt,
      updatedAt: runs.updatedAt,
    })
    .from(runs)
    .leftJoin(agents, eq(runs.agentId, agents.id))
    .where(eq(runs.parentRunId, id))
    .orderBy(desc(runs.createdAt));

  return { children };
}
