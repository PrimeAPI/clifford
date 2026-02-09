import { getDb, messages, runs, runSteps, agents } from '@clifford/db';
import { eq, desc, inArray } from 'drizzle-orm';

export async function loadRecentMessages(
  db: ReturnType<typeof getDb>,
  contextId: string,
  limit: number
) {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.contextId, contextId))
    .orderBy(desc(messages.createdAt))
    .limit(limit);

  return rows.reverse().map((row) => ({
    direction: row.direction as 'inbound' | 'outbound',
    content: row.content,
    createdAt: row.createdAt?.toISOString?.() ?? undefined,
  }));
}

export async function getContextExport(db: ReturnType<typeof getDb>, contextId: string) {
  // Get all messages
  const allMessages = await db
    .select()
    .from(messages)
    .where(eq(messages.contextId, contextId))
    .orderBy(messages.createdAt);

  // Get all runs with agent info
  const runsData = await db
    .select({
      run: runs,
      agentName: agents.name,
    })
    .from(runs)
    .leftJoin(agents, eq(runs.agentId, agents.id))
    .where(eq(runs.contextId, contextId))
    .orderBy(runs.createdAt);

  // Get all steps for these runs
  const runIds = runsData.map((r) => r.run.id);
  const stepsData = runIds.length > 0
    ? await db
        .select()
        .from(runSteps)
        .where(inArray(runSteps.runId, runIds))
        .orderBy(runSteps.runId, runSteps.seq)
    : [];

  // Organize steps by run
  const stepsByRun = new Map<string, typeof stepsData>();
  for (const step of stepsData) {
    if (!stepsByRun.has(step.runId)) {
      stepsByRun.set(step.runId, []);
    }
    stepsByRun.get(step.runId)!.push(step);
  }

  // Build export structure
  const exportData = {
    messages: allMessages,
    runs: runsData.map((r) => ({
      ...r.run,
      agentName: r.agentName,
      steps: stepsByRun.get(r.run.id) ?? [],
    })),
  };

  return exportData;
}
