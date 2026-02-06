import type { FastifyInstance } from 'fastify';
import { getDb, userSettings } from '@clifford/db';
import { eq } from 'drizzle-orm';
import { config } from '../../config.js';
import { encryptSecret } from '@clifford/core';
import {
  crossChannelSchema,
  llmSettingsSchema,
  memorySchema,
  systemPromptSchema,
} from './settings.schema.js';
import { DEFAULT_SYSTEM_PROMPT, ensureSettings, ensureUser } from './settings.service.js';

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
      fallbackModel: settings?.llmFallbackModel ?? null,
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

    if (body.fallbackModel !== undefined) {
      updates.llmFallbackModel = body.fallbackModel?.trim() || null;
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
      fallbackModel: merged?.llmFallbackModel ?? null,
      hasApiKey: Boolean(merged?.llmApiKeyEncrypted),
      apiKeyLast4: merged?.llmApiKeyLast4 ?? null,
    };
  });

  app.get('/api/settings/system-prompt', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const db = getDb();
    await ensureUser(db, userId);
    const settings = await ensureSettings(db, userId);

    return {
      defaultSystemPrompt: settings?.defaultSystemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    };
  });

  app.put('/api/settings/system-prompt', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const body = systemPromptSchema.parse(req.body);
    const db = getDb();
    await ensureUser(db, userId);
    const existing = await ensureSettings(db, userId);

    const nextPrompt = body.defaultSystemPrompt ?? DEFAULT_SYSTEM_PROMPT;

    const [updated] = await db
      .update(userSettings)
      .set({ defaultSystemPrompt: nextPrompt, updatedAt: new Date() })
      .where(eq(userSettings.userId, userId))
      .returning();

    const merged = updated ?? existing;

    return {
      defaultSystemPrompt: merged?.defaultSystemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    };
  });

  app.get('/api/settings/context-bridge', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const db = getDb();
    await ensureUser(db, userId);
    const settings = await ensureSettings(db, userId);

    return {
      enabled: settings?.crossChannelContextEnabled ?? true,
      limit: settings?.crossChannelContextLimit ?? 12,
    };
  });

  app.put('/api/settings/context-bridge', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const body = crossChannelSchema.parse(req.body);
    const db = getDb();
    await ensureUser(db, userId);
    const existing = await ensureSettings(db, userId);

    const updates: Partial<typeof userSettings.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (body.enabled !== undefined) {
      updates.crossChannelContextEnabled = body.enabled;
    }

    if (body.limit !== undefined) {
      updates.crossChannelContextLimit = body.limit;
    }

    const [updated] = await db
      .update(userSettings)
      .set(updates)
      .where(eq(userSettings.userId, userId))
      .returning();

    const merged = updated ?? existing;

    return {
      enabled: merged?.crossChannelContextEnabled ?? true,
      limit: merged?.crossChannelContextLimit ?? 12,
    };
  });

  app.get('/api/settings/memory', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const db = getDb();
    await ensureUser(db, userId);
    const settings = await ensureSettings(db, userId);

    return {
      enabled: settings?.memoryEnabled ?? true,
    };
  });

  app.put('/api/settings/memory', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const body = memorySchema.parse(req.body);
    const db = getDb();
    await ensureUser(db, userId);
    const existing = await ensureSettings(db, userId);

    const updates: Partial<typeof userSettings.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (body.enabled !== undefined) {
      updates.memoryEnabled = body.enabled;
    }

    const [updated] = await db
      .update(userSettings)
      .set(updates)
      .where(eq(userSettings.userId, userId))
      .returning();

    const merged = updated ?? existing;

    return {
      enabled: merged?.memoryEnabled ?? true,
    };
  });
}
