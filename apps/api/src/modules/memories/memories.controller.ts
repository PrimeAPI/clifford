import type { FastifyInstance } from 'fastify';
import { getDb, memoryItems } from '@clifford/db';
import { and, eq } from 'drizzle-orm';
import { memoryCreateSchema, memoryUpdateSchema } from './memories.schema.js';
import {
  clampConfidence,
  containsSecret,
  enforceCaps,
  ensureSettings,
  ensureUser,
  maxCharsForLevel,
  selectActiveMemories,
} from './memories.service.js';

export async function memoryRoutes(app: FastifyInstance) {
  app.get('/api/memories', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const db = getDb();
    await ensureUser(db, userId);
    const settings = await ensureSettings(db, userId);

    if (settings?.memoryEnabled === false) {
      return { enabled: false, memories: [] };
    }

    const items = await db
      .select()
      .from(memoryItems)
      .where(and(eq(memoryItems.userId, userId), eq(memoryItems.archived, false)));

    const selected = selectActiveMemories(items);

    return {
      enabled: true,
      memories: selected,
    };
  });

  app.post('/api/memories', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const body = memoryCreateSchema.parse(req.body);
    const db = getDb();
    await ensureUser(db, userId);

    if (containsSecret(body.value) || containsSecret(body.key)) {
      return reply.status(400).send({ error: 'Memory value contains sensitive data' });
    }

    const maxChars = maxCharsForLevel(body.level);
    const value = body.value.slice(0, maxChars);
    const [created] = await db
      .insert(memoryItems)
      .values({
        userId,
        level: body.level,
        module: body.module.trim(),
        key: body.key.trim(),
        value,
        confidence: clampConfidence(body.confidence),
        pinned: body.pinned ?? false,
        archived: false,
        createdAt: new Date(),
        lastSeenAt: new Date(),
      })
      .returning();

    if (created) {
      await enforceCaps(db, userId);
    }

    return { memory: created };
  });

  app.put('/api/memories/:id', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const memoryId = (req.params as { id: string }).id;
    const body = memoryUpdateSchema.parse(req.body);
    const db = getDb();
    await ensureUser(db, userId);

    const [existing] = await db
      .select()
      .from(memoryItems)
      .where(and(eq(memoryItems.userId, userId), eq(memoryItems.id, memoryId)))
      .limit(1);

    if (!existing) {
      return reply.status(404).send({ error: 'Memory not found' });
    }

    const nextLevel = body.level ?? existing.level;
    const maxChars = maxCharsForLevel(nextLevel);
    const nextValue = body.value ? body.value.slice(0, maxChars) : existing.value;

    if (containsSecret(nextValue) || (body.key && containsSecret(body.key))) {
      return reply.status(400).send({ error: 'Memory value contains sensitive data' });
    }

    const [updated] = await db
      .update(memoryItems)
      .set({
        level: nextLevel,
        module: body.module?.trim() ?? existing.module,
        key: body.key?.trim() ?? existing.key,
        value: nextValue,
        confidence: clampConfidence(body.confidence ?? existing.confidence),
        pinned: body.pinned ?? existing.pinned,
        lastSeenAt: new Date(),
        archived: false,
      })
      .where(eq(memoryItems.id, memoryId))
      .returning();

    if (updated) {
      await enforceCaps(db, userId);
    }

    return { memory: updated };
  });

  app.delete('/api/memories/:id', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const memoryId = (req.params as { id: string }).id;
    const db = getDb();
    await ensureUser(db, userId);

    const [existing] = await db
      .select()
      .from(memoryItems)
      .where(and(eq(memoryItems.userId, userId), eq(memoryItems.id, memoryId)))
      .limit(1);

    if (!existing) {
      return reply.status(404).send({ error: 'Memory not found' });
    }

    await db.update(memoryItems).set({ archived: true }).where(eq(memoryItems.id, memoryId));

    return { success: true };
  });
}
