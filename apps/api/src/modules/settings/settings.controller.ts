import type { FastifyInstance } from 'fastify';
import { getDb, userSettings } from '@clifford/db';
import { eq } from 'drizzle-orm';
import { config } from '../../config.js';
import {
  DEFAULT_MODEL_ROUTING_CONFIG,
  encryptSecret,
  MODEL_CATALOG,
  getDefaultEnabledModelIds,
  normalizeModelRoutingPolicy,
  type ModelRoutingConfig,
} from '@clifford/core';
import {
  crossChannelSchema,
  llmSettingsSchema,
  memorySchema,
  systemPromptSchema,
} from './settings.schema.js';
import { DEFAULT_SYSTEM_PROMPT, ensureSettings, ensureUser } from './settings.service.js';

function buildRoutingDefaults(model?: string | null, fallbackModel?: string | null): ModelRoutingConfig {
  const baseModel = model?.trim() || DEFAULT_MODEL_ROUTING_CONFIG.executor.model;
  const baseFallback = fallbackModel?.trim() || null;
  return {
    planner: {
      ...DEFAULT_MODEL_ROUTING_CONFIG.planner,
      model: baseModel,
      fallbackModel: baseFallback,
    },
    executor: {
      ...DEFAULT_MODEL_ROUTING_CONFIG.executor,
      model: baseModel,
      fallbackModel: baseFallback,
    },
    verifier: {
      ...DEFAULT_MODEL_ROUTING_CONFIG.verifier,
      model: baseModel,
      fallbackModel: baseFallback,
    },
  };
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
    const routingPolicy = normalizeModelRoutingPolicy(
      settings?.routingConfig,
      buildRoutingDefaults(settings?.llmModel, settings?.llmFallbackModel)
    );

    return {
      provider: settings?.llmProvider ?? 'openai',
      model: settings?.llmModel ?? 'gpt-4o-mini',
      fallbackModel: settings?.llmFallbackModel ?? null,
      autoSelectLowestCost: routingPolicy.autoSelectLowestCost,
      routing: routingPolicy,
      availableModels: MODEL_CATALOG.map((model) => ({
        id: model.id,
        name: model.name,
        costLevel: model.costLevel,
        bestFor: model.bestFor,
        enabled: routingPolicy.enabledModelIds.includes(model.id),
      })),
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
    const routingPolicy = normalizeModelRoutingPolicy(
      existing?.routingConfig,
      buildRoutingDefaults(existing?.llmModel, existing?.llmFallbackModel)
    );

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

    const nextRoutingPolicy = {
      ...routingPolicy,
      autoSelectLowestCost: body.autoSelectLowestCost ?? routingPolicy.autoSelectLowestCost,
      enabledModelIds: body.enabledModelIds ?? routingPolicy.enabledModelIds,
      draft: (body.routingDraft as ModelRoutingConfig | undefined) ?? routingPolicy.draft,
    };

    if (!nextRoutingPolicy.enabledModelIds.length) {
      nextRoutingPolicy.enabledModelIds = getDefaultEnabledModelIds();
    }

    if (body.model) {
      nextRoutingPolicy.draft.executor.model = body.model.trim();
    }
    if (body.fallbackModel !== undefined) {
      nextRoutingPolicy.draft.executor.fallbackModel = body.fallbackModel?.trim() || null;
    }

    // Backward compatibility: legacy clients that only send model/fallback should still apply.
    const isLegacyModelUpdate = !body.routingDraft && (body.model !== undefined || body.fallbackModel !== undefined);
    if (isLegacyModelUpdate) {
      nextRoutingPolicy.active = {
        ...nextRoutingPolicy.active,
        executor: {
          ...nextRoutingPolicy.draft.executor,
        },
      };
      nextRoutingPolicy.activatedAt = new Date().toISOString();
    }

    if (body.activateDraft) {
      nextRoutingPolicy.active = {
        planner: { ...nextRoutingPolicy.draft.planner },
        executor: { ...nextRoutingPolicy.draft.executor },
        verifier: { ...nextRoutingPolicy.draft.verifier },
      };
      nextRoutingPolicy.activatedAt = new Date().toISOString();
      updates.llmModel = nextRoutingPolicy.active.executor.model;
      updates.llmFallbackModel = nextRoutingPolicy.active.executor.fallbackModel ?? null;
    }

    if (isLegacyModelUpdate) {
      updates.llmModel = nextRoutingPolicy.active.executor.model;
      updates.llmFallbackModel = nextRoutingPolicy.active.executor.fallbackModel ?? null;
    }

    updates.routingConfig = normalizeModelRoutingPolicy(
      nextRoutingPolicy,
      buildRoutingDefaults(existing?.llmModel, existing?.llmFallbackModel)
    );

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
    const mergedPolicy = normalizeModelRoutingPolicy(
      merged?.routingConfig,
      buildRoutingDefaults(merged?.llmModel, merged?.llmFallbackModel)
    );

    return {
      provider: merged?.llmProvider ?? 'openai',
      model: merged?.llmModel ?? 'gpt-4o-mini',
      fallbackModel: merged?.llmFallbackModel ?? null,
      autoSelectLowestCost: mergedPolicy.autoSelectLowestCost,
      routing: mergedPolicy,
      availableModels: MODEL_CATALOG.map((model) => ({
        id: model.id,
        name: model.name,
        costLevel: model.costLevel,
        bestFor: model.bestFor,
        enabled: mergedPolicy.enabledModelIds.includes(model.id),
      })),
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
