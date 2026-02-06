import { getDb, messages, channels, contexts } from '@clifford/db';
import { eq, inArray } from 'drizzle-orm';

export const JOB_LIMIT = 25;

export function serializeJob(job: any, extra?: { detail?: string; meta?: Record<string, unknown> }) {
  return {
    id: job.id,
    name: job.name,
    data: job.data,
    timestamp: job.timestamp,
    processedOn: job.processedOn,
    finishedOn: job.finishedOn,
    failedReason: job.failedReason,
    result: job.returnvalue,
    detail: extra?.detail,
    meta: extra?.meta,
  };
}

export async function buildMessageMeta(db: ReturnType<typeof getDb>, jobs: any[]) {
  const messageIds = jobs
    .map((job) => job?.data?.messageId)
    .filter((id): id is string => Boolean(id));

  if (messageIds.length === 0) {
    return new Map<string, { detail: string; meta: Record<string, unknown> }>();
  }

  const rows = await db
    .select({
      id: messages.id,
      channelId: messages.channelId,
      contextId: messages.contextId,
      content: messages.content,
      direction: messages.direction,
      channelName: channels.name,
      contextName: contexts.name,
    })
    .from(messages)
    .leftJoin(channels, eq(messages.channelId, channels.id))
    .leftJoin(contexts, eq(messages.contextId, contexts.id))
    .where(inArray(messages.id, messageIds));

  const meta = new Map<string, { detail: string; meta: Record<string, unknown> }>();
  for (const row of rows) {
    meta.set(row.id, {
      detail: `${row.direction === 'inbound' ? 'User' : 'Assistant'}: ${row.content}`,
      meta: {
        channelId: row.channelId,
        channelName: row.channelName,
        contextId: row.contextId,
        contextName: row.contextName,
        source: 'chat',
      },
    });
  }

  return meta;
}

export async function buildMemoryMeta(db: ReturnType<typeof getDb>, jobs: any[]) {
  const contextIds = jobs
    .map((job) => job?.data?.contextId)
    .filter((id): id is string => Boolean(id));

  if (contextIds.length === 0) {
    return new Map<string, { detail: string; meta: Record<string, unknown> }>();
  }

  const rows = await db
    .select({
      id: contexts.id,
      name: contexts.name,
      channelId: contexts.channelId,
      channelName: channels.name,
    })
    .from(contexts)
    .leftJoin(channels, eq(contexts.channelId, channels.id))
    .where(inArray(contexts.id, contextIds));

  const byContextId = new Map<
    string,
    { contextName: string | null; channelId: string | null; channelName: string | null }
  >();
  for (const row of rows) {
    byContextId.set(row.id, {
      contextName: row.name ?? null,
      channelId: row.channelId ?? null,
      channelName: row.channelName ?? null,
    });
  }

  const meta = new Map<string, { detail: string; meta: Record<string, unknown> }>();
  for (const job of jobs) {
    const contextId = job?.data?.contextId as string | undefined;
    const mode = job?.data?.mode as string | undefined;
    const contextInfo = contextId ? byContextId.get(contextId) : null;
    const detail = mode ? `Memory write (${mode})` : 'Memory write';
    meta.set(job.id, {
      detail,
      meta: {
        contextId,
        contextName: contextInfo?.contextName ?? null,
        channelId: contextInfo?.channelId ?? null,
        channelName: contextInfo?.channelName ?? null,
        source: mode === 'compact' ? 'compaction' : 'context_close',
      },
    });
  }

  return meta;
}
