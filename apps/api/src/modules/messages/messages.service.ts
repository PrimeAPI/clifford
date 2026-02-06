import { getDb, channels, contexts } from '@clifford/db';
import { eq, and } from 'drizzle-orm';
import { ensureActiveContext } from '../../context.js';

export async function findUserChannel(
  db: ReturnType<typeof getDb>,
  channelId: string,
  userId: string
) {
  const [channel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.userId, userId)))
    .limit(1);
  return channel ?? null;
}

export async function resolveContextIdForMessage(
  db: ReturnType<typeof getDb>,
  channel: typeof channels.$inferSelect,
  contextId?: string
) {
  if (contextId) {
    const [context] = await db
      .select()
      .from(contexts)
      .where(and(eq(contexts.id, contextId), eq(contexts.channelId, channel.id)))
      .limit(1);
    return context ?? null;
  }

  const active = await ensureActiveContext(db, channel);
  const resolvedId = active?.id ?? channel.activeContextId ?? null;
  return resolvedId ? { id: resolvedId } : null;
}
