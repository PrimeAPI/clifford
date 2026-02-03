import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, users, userSettings } from '@clifford/db';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { encryptSecret } from '../crypto.js';

const llmSettingsSchema = z.object({
  provider: z.enum(['openai']).optional(),
  model: z.string().min(1).optional(),
  apiKey: z.string().optional().nullable(),
});

async function ensureUser(db: ReturnType<typeof getDb>, userId: string) {
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

async function ensureSettings(db: ReturnType<typeof getDb>, userId: string) {
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

export async function settingsRoutes(app: FastifyInstance) {
  app.get('/api/settings/llm', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const db = getDb();
    await ensureUser(db, userId);
    const settings = await ensureSettings(db, userId);

    return {
      provider: settings?.llmProvider ?? 'openai',
      model: settings?.llmModel ?? 'gpt-4o-mini',
      hasApiKey: Boolean(settings?.llmApiKeyEncrypted),
      apiKeyLast4: settings?.llmApiKeyLast4 ?? null,
    };
  });

  app.put('/api/settings/llm', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const body = llmSettingsSchema.parse(req.body);
    const db = getDb();
    await ensureUser(db, userId);
    const existing = await ensureSettings(db, userId);

    const updates: Partial<typeof userSettings.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (body.provider) {
      updates.llmProvider = body.provider;
    }

    if (body.model) {
      updates.llmModel = body.model;
    }

    if (body.apiKey !== undefined) {
      if (!body.apiKey) {
        updates.llmApiKeyEncrypted = null;
        updates.llmApiKeyIv = null;
        updates.llmApiKeyTag = null;
        updates.llmApiKeyLast4 = null;
      } else {
        if (!config.encryptionKey) {
          return reply.status(500).send({ error: 'Encryption key not configured' });
        }
        const encrypted = encryptSecret(body.apiKey, config.encryptionKey);
        updates.llmApiKeyEncrypted = encrypted.cipherText;
        updates.llmApiKeyIv = encrypted.iv;
        updates.llmApiKeyTag = encrypted.tag;
        updates.llmApiKeyLast4 = body.apiKey.slice(-4);
      }
    }

    const [updated] = await db
      .update(userSettings)
      .set(updates)
      .where(eq(userSettings.userId, userId))
      .returning();

    const merged = updated ?? existing;

    return {
      provider: merged?.llmProvider ?? 'openai',
      model: merged?.llmModel ?? 'gpt-4o-mini',
      hasApiKey: Boolean(merged?.llmApiKeyEncrypted),
      apiKeyLast4: merged?.llmApiKeyLast4 ?? null,
    };
  });
}
