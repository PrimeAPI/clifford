import { getDb, messages } from '@clifford/db';
import { eq, desc } from 'drizzle-orm';

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
    direction: row.direction,
    content: row.content,
    createdAt: row.createdAt?.toISOString?.() ?? undefined,
  }));
}
