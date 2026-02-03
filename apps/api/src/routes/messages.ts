import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, messages, channels, contexts } from '@clifford/db';
import { eq, and, desc } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { enqueueMessage } from '../queue.js';
import { ensureActiveContext } from '../context.js';

const sendMessageSchema = z.object({
  channelId: z.string(),
  content: z.string().min(1),
  contextId: z.string().uuid().optional(),
});

export async function messageRoutes(app: FastifyInstance) {
  // List messages for user
  app.get<{ Querystring: { channelId?: string; contextId?: string } }>(
    '/api/messages',
    async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const channelId = req.query.channelId;
    const contextId = req.query.contextId;
    const db = getDb();

    let query = db
      .select({
        message: messages,
        channel: channels,
      })
      .from(messages)
      .innerJoin(channels, eq(messages.channelId, channels.id))
      .where(eq(messages.userId, userId))
      .orderBy(desc(messages.createdAt))
      .limit(100);

    if (channelId) {
      const [channel] = await db
        .select()
        .from(channels)
        .where(and(eq(channels.id, channelId), eq(channels.userId, userId)))
        .limit(1);

      if (!channel) {
        return reply.status(404).send({ error: 'Channel not found' });
      }

      let scopedContextId: string | null = null;
      if (contextId) {
        const [context] = await db
          .select()
          .from(contexts)
          .where(and(eq(contexts.id, contextId), eq(contexts.channelId, channel.id)))
          .limit(1);

        if (!context) {
          return reply.status(404).send({ error: 'Context not found' });
        }
        scopedContextId = context.id;
      } else {
        const active = await ensureActiveContext(db, channel);
        scopedContextId = active?.id ?? channel.activeContextId ?? null;
      }

      query = db
        .select({
          message: messages,
          channel: channels,
        })
        .from(messages)
        .innerJoin(channels, eq(messages.channelId, channels.id))
        .where(
          and(
            eq(messages.userId, userId),
            eq(messages.channelId, channelId),
            scopedContextId ? eq(messages.contextId, scopedContextId) : eq(messages.contextId, null)
          )
        )
        .orderBy(desc(messages.createdAt))
        .limit(100);
    }

    const results = await query;

    return {
      messages: results.map((r) => ({
        ...r.message,
        channel: r.channel,
      })),
    };
  });

  // Send message
  app.post('/api/messages', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const body = sendMessageSchema.parse(req.body);
    const db = getDb();

    // Verify channel belongs to user
    const [channel] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.id, body.channelId), eq(channels.userId, userId)))
      .limit(1);

    if (!channel) {
      return reply.status(404).send({ error: 'Channel not found' });
    }

    let contextId: string | null = null;
    if (body.contextId) {
      const [context] = await db
        .select()
        .from(contexts)
        .where(and(eq(contexts.id, body.contextId), eq(contexts.channelId, channel.id)))
        .limit(1);

      if (!context) {
        return reply.status(400).send({ error: 'Context not found for channel' });
      }
      contextId = context.id;
    } else {
      const active = await ensureActiveContext(db, channel);
      contextId = active?.id ?? channel.activeContextId ?? null;
    }

    const [message] = await db
      .insert(messages)
      .values({
        id: randomUUID(),
        userId,
        channelId: body.channelId,
        contextId,
        content: body.content,
        direction: 'inbound',
        deliveryStatus: 'delivered',
        deliveredAt: new Date(),
      })
      .returning();

    if (contextId) {
      await db
        .update(contexts)
        .set({ lastUserInteractionAt: new Date(), updatedAt: new Date() })
        .where(eq(contexts.id, contextId));
    }

    if (message) {
      await enqueueMessage({
        type: 'message',
        messageId: message.id,
      });
    }

    app.log.info({ messageId: message?.id, channelId: body.channelId }, 'Message sent');

    return { message };
  });
}
