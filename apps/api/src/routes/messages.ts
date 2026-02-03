import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, messages, channels } from '@clifford/db';
import { eq, and, desc } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { enqueueMessage } from '../queue.js';

const sendMessageSchema = z.object({
  channelId: z.string(),
  content: z.string().min(1),
});

export async function messageRoutes(app: FastifyInstance) {
  // List messages for user
  app.get<{ Querystring: { channelId?: string } }>('/api/messages', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const channelId = req.query.channelId;
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
      query = db
        .select({
          message: messages,
          channel: channels,
        })
        .from(messages)
        .innerJoin(channels, eq(messages.channelId, channels.id))
        .where(and(eq(messages.userId, userId), eq(messages.channelId, channelId)))
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

    const [message] = await db
      .insert(messages)
      .values({
        id: randomUUID(),
        userId,
        channelId: body.channelId,
        content: body.content,
        direction: 'inbound',
        deliveryStatus: 'delivered',
        deliveredAt: new Date(),
      })
      .returning();

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
