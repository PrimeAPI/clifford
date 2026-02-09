import type { FastifyInstance } from 'fastify';
import { getDb, channels, contexts } from '@clifford/db';
import { eq, and, desc } from 'drizzle-orm';
import { ensureActiveContext, createContext } from '../../context.js';
import { enqueueMemoryWrite } from '../../queue.js';
import { createContextSchema, listContextsQuerySchema } from './contexts.schema.js';
import { loadRecentMessages, getContextExport } from './contexts.service.js';

export async function contextRoutes(app: FastifyInstance) {
  // List contexts for a channel
  app.get('/api/contexts', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const query = listContextsQuerySchema.parse(req.query);
    const db = getDb();

    const [channel] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.id, query.channelId), eq(channels.userId, userId)))
      .limit(1);

    if (!channel) {
      return reply.status(404).send({ error: 'Channel not found' });
    }

    const active = await ensureActiveContext(db, channel);

    const items = await db
      .select()
      .from(contexts)
      .where(eq(contexts.channelId, channel.id))
      .orderBy(desc(contexts.createdAt));

    return {
      contexts: items,
      activeContextId: active?.id ?? channel.activeContextId ?? null,
    };
  });

  // Create and activate a new context
  app.post('/api/contexts', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const body = createContextSchema.parse(req.body);
    const db = getDb();

    const [channel] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.id, body.channelId), eq(channels.userId, userId)))
      .limit(1);

    if (!channel) {
      return reply.status(404).send({ error: 'Channel not found' });
    }

    if (channel.activeContextId) {
      const [activeContext] = await db
        .select()
        .from(contexts)
        .where(eq(contexts.id, channel.activeContextId))
        .limit(1);

      if (activeContext && !activeContext.closedAt) {
        const segmentMessages = await loadRecentMessages(db, activeContext.id, 40);
        await db
          .update(contexts)
          .set({ closedAt: new Date(), updatedAt: new Date() })
          .where(eq(contexts.id, activeContext.id));

        await enqueueMemoryWrite({
          type: 'memory_write',
          contextId: activeContext.id,
          userId: activeContext.userId,
          mode: 'close',
          segmentMessages,
        });
      }
    }

    const created = await createContext(db, channel, body.name);

    return {
      context: created,
      activeContextId: created?.id ?? channel.activeContextId ?? null,
    };
  });

  // Activate an existing context
  app.post<{ Params: { id: string } }>('/api/contexts/:id/activate', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { id } = req.params;
    const db = getDb();

    const [context] = await db
      .select({
        id: contexts.id,
        channelId: contexts.channelId,
        userId: contexts.userId,
      })
      .from(contexts)
      .where(eq(contexts.id, id))
      .limit(1);

    if (!context || context.userId !== userId) {
      return reply.status(404).send({ error: 'Context not found' });
    }

    await db
      .update(channels)
      .set({ activeContextId: context.id, updatedAt: new Date() })
      .where(and(eq(channels.id, context.channelId), eq(channels.userId, userId)));

    return { activeContextId: context.id };
  });

  // Close a context and trigger memory write
  app.post<{ Params: { id: string } }>('/api/contexts/:id/close', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { id } = req.params;
    const db = getDb();

    const [context] = await db.select().from(contexts).where(eq(contexts.id, id)).limit(1);

    if (!context || context.userId !== userId) {
      return reply.status(404).send({ error: 'Context not found' });
    }

    if (!context.closedAt) {
      const segmentMessages = await loadRecentMessages(db, context.id, 40);
      await db
        .update(contexts)
        .set({ closedAt: new Date(), updatedAt: new Date() })
        .where(eq(contexts.id, id));

      await enqueueMemoryWrite({
        type: 'memory_write',
        contextId: context.id,
        userId: context.userId,
        mode: 'close',
        segmentMessages,
      });
    }

    await db
      .update(channels)
      .set({ activeContextId: null, updatedAt: new Date() })
      .where(and(eq(channels.id, context.channelId), eq(channels.userId, userId)));

    return { closed: true };
  });

  // Get full context export for debugging
  app.get<{ Params: { id: string } }>('/api/contexts/:id/export', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { id } = req.params;
    const db = getDb();

    const [context] = await db.select().from(contexts).where(eq(contexts.id, id)).limit(1);

    if (!context || context.userId !== userId) {
      return reply.status(404).send({ error: 'Context not found' });
    }

    const exportData = await getContextExport(db, id);

    return {
      context,
      ...exportData,
    };
  });
}
