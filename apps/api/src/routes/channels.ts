import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, channels, users } from '@clifford/db';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';

// Ensure the demo user exists (temporary until proper auth is implemented)
async function ensureDemoUser(db: ReturnType<typeof getDb>, userId: string) {
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

const createChannelSchema = z.object({
  type: z.enum(['web', 'discord']),
  name: z.string().min(1),
  agentId: z.string().uuid().optional(),
  config: z.record(z.unknown()).optional(),
});

const updateChannelSchema = z.object({
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  agentId: z.string().uuid().nullable().optional(),
  config: z.record(z.unknown()).optional(),
});

export async function channelRoutes(app: FastifyInstance) {
  // List channels for user (auto-creates web channel if missing)
  app.get('/api/channels', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const db = getDb();
    let userChannels = await db
      .select()
      .from(channels)
      .where(eq(channels.userId, userId))
      .orderBy(channels.createdAt);

    // Auto-create web channel if it doesn't exist
    const hasWebChannel = userChannels.some((c) => c.type === 'web');
    if (!hasWebChannel) {
      // Ensure user exists first
      await ensureDemoUser(db, userId);

      const [webChannel] = await db
        .insert(channels)
        .values({
          id: randomUUID(),
          userId,
          type: 'web',
          name: 'Web Chat',
          enabled: true,
        })
        .returning();

      if (webChannel) {
        app.log.info({ userId, channelId: webChannel.id }, 'Auto-created web channel');
        userChannels = [webChannel, ...userChannels];
      }
    }

    return { channels: userChannels };
  });

  // Create channel
  app.post('/api/channels', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const body = createChannelSchema.parse(req.body);
    const db = getDb();

    const [channel] = await db
      .insert(channels)
      .values({
        id: randomUUID(),
        userId,
        agentId: body.agentId,
        type: body.type,
        name: body.name,
        config: body.config as any,
        enabled: true,
      })
      .returning();

    app.log.info({ channelId: channel?.id, type: body.type }, 'Channel created');

    return { channel };
  });

  // Update channel
  app.patch<{ Params: { id: string } }>('/api/channels/:id', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { id } = req.params;
    const body = updateChannelSchema.parse(req.body);
    const db = getDb();

    const [channel] = await db
      .update(channels)
      .set({
        ...body,
        config: body.config as any,
        updatedAt: new Date(),
      })
      .where(and(eq(channels.id, id), eq(channels.userId, userId)))
      .returning();

    if (!channel) {
      return reply.status(404).send({ error: 'Channel not found' });
    }

    return { channel };
  });

  // Delete channel
  app.delete<{ Params: { id: string } }>('/api/channels/:id', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { id } = req.params;
    const db = getDb();

    // Check if it's the web channel (can't delete)
    const [channel] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.id, id), eq(channels.userId, userId)))
      .limit(1);

    if (!channel) {
      return reply.status(404).send({ error: 'Channel not found' });
    }

    if (channel.type === 'web') {
      return reply.status(400).send({ error: 'Cannot delete web channel' });
    }

    await db.delete(channels).where(and(eq(channels.id, id), eq(channels.userId, userId)));

    return { success: true };
  });
}
