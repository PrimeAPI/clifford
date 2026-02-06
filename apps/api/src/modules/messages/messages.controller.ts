import type { FastifyInstance } from 'fastify';
import { getDb, messages, channels, contexts, agents, runs } from '@clifford/db';
import { eq, and, desc } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { enqueueRun } from '../../queue.js';
import { sendMessageSchema } from './messages.schema.js';
import { findUserChannel, resolveContextIdForMessage } from './messages.service.js';

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
        const channel = await findUserChannel(db, channelId, userId);
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
          const resolved = await resolveContextIdForMessage(db, channel, undefined);
          scopedContextId = resolved?.id ?? null;
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
    }
  );

  // Send message
  app.post('/api/messages', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const body = sendMessageSchema.parse(req.body);
    const db = getDb();

    // Verify channel belongs to user
    const channel = await findUserChannel(db, body.channelId, userId);
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
      const resolved = await resolveContextIdForMessage(db, channel, undefined);
      contextId = resolved?.id ?? null;
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
      const [agent] = channel?.agentId
        ? await db.select().from(agents).where(eq(agents.id, channel.agentId)).limit(1)
        : await db.select().from(agents).where(eq(agents.enabled, true)).limit(1);
      if (!agent) {
        await db.insert(messages).values({
          id: randomUUID(),
          userId,
          channelId: body.channelId,
          contextId,
          content: 'No enabled agent is configured for this channel.',
          direction: 'outbound',
          deliveryStatus: 'delivered',
          deliveredAt: new Date(),
          metadata: JSON.stringify({ error: true, replyTo: message.id }),
        });
        return reply.status(500).send({ error: 'No enabled agent found' });
      }

      const runId = randomUUID();
      await db.insert(runs).values({
        id: runId,
        tenantId: agent.tenantId,
        agentId: agent.id,
        userId,
        channelId: body.channelId,
        contextId,
        kind: 'coordinator',
        rootRunId: runId,
        inputText: body.content,
        outputText: '',
        status: 'pending',
      });

      await db
        .update(messages)
        .set({
          metadata: JSON.stringify({ runId, kind: 'coordinator' }),
        })
        .where(eq(messages.id, message.id));

      await enqueueRun({
        type: 'run',
        runId,
        tenantId: agent.tenantId,
        agentId: agent.id,
      });

      app.log.info({ runId, agentId: agent.id, channelId: body.channelId }, 'Run enqueued');
    }

    app.log.info({ messageId: message?.id, channelId: body.channelId }, 'Message sent');

    return { message };
  });
}
