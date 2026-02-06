import { getDb, users, userSettings } from '@clifford/db';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';

export const DEFAULT_SYSTEM_PROMPT =
  'You are Clifford, a very skilled and highly complex AI-Assistent!';

export async function ensureUser(db: ReturnType<typeof getDb>, userId: string) {
  const [existingUser] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!existingUser) {
    await db
      .insert(users)
      .values({
        id: userId,
        email: 'demo@clifford.ai',
        name: 'Demo User',
      })
      .onConflictDoNothing();
  }
}

export async function ensureSettings(db: ReturnType<typeof getDb>, userId: string) {
  const [existingSettings] = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);

  if (existingSettings) {
    return existingSettings;
  }

  const [created] = await db
    .insert(userSettings)
    .values({
      id: randomUUID(),
      userId,
    })
    .returning();

  return created;
}
