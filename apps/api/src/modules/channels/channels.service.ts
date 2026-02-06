import { getDb, users } from '@clifford/db';
import { eq } from 'drizzle-orm';

// Ensure the demo user exists (temporary until proper auth is implemented)
export async function ensureDemoUser(db: ReturnType<typeof getDb>, userId: string) {
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
