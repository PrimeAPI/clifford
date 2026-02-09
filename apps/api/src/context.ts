import { randomUUID } from 'crypto';
import { contexts, channels, messages, getDb } from '@clifford/db';
import { eq, desc, sql } from 'drizzle-orm';

type DbClient = ReturnType<typeof getDb>;

interface ChannelRow {
  id: string;
  userId: string;
  activeContextId: string | null;
}

export async function ensureActiveContext(db: DbClient, channel: ChannelRow) {
  if (channel.activeContextId) {
    const [existing] = await db
      .select()
      .from(contexts)
      .where(eq(contexts.id, channel.activeContextId))
      .limit(1);
    if (existing && !existing.closedAt) {
      return existing;
    }
  }

  const [recent] = await db
    .select()
    .from(contexts)
    .where(eq(contexts.channelId, channel.id))
    .orderBy(desc(contexts.createdAt))
    .limit(1);

  if (recent && !recent.closedAt) {
    await db
      .update(channels)
      .set({ activeContextId: recent.id, updatedAt: new Date() })
      .where(eq(channels.id, channel.id));
    return recent;
  }

  return await createContext(db, channel, undefined);
}

export async function createContext(db: DbClient, channel: ChannelRow, name?: string) {
  const [countRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(contexts)
    .where(eq(contexts.channelId, channel.id));
  const count = countRow?.count ?? 0;

  const existingCount = Number(count ?? 0);
  const nextIndex = existingCount + 1;
  const finalName = name?.trim() || `Context ${nextIndex}`;

  const [created] = await db
    .insert(contexts)
    .values({
      id: randomUUID(),
      userId: channel.userId,
      channelId: channel.id,
      name: finalName,
    })
    .returning();

  if (created) {
    await db
      .update(channels)
      .set({ activeContextId: created.id, updatedAt: new Date() })
      .where(eq(channels.id, channel.id));

    if (existingCount === 0) {
      await db
        .update(messages)
        .set({ contextId: created.id })
        .where(eq(messages.channelId, channel.id));
    }
  }

  return created;
}
