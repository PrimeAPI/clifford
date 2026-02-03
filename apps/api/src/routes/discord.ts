import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, discordConnections, channels, messages, contexts } from '@clifford/db';
import { eq, and, sql, desc } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { enqueueMessage, enqueueMemoryWrite } from '../queue.js';
import { ensureActiveContext, createContext } from '../context.js';
import { config } from '../config.js';

const discordEventSchema = z.object({
  discordUserId: z.string(),
  discordUsername: z.string(),
  discordAvatar: z.string().nullable().optional(),
  content: z.string(),
  channelId: z.string().optional(),
  messageId: z.string().optional(),
});

const connectDiscordSchema = z.object({
  code: z.string(),
});

const discordContextQuerySchema = z.object({
  discordUserId: z.string(),
  discordUsername: z.string().optional(),
});

const discordContextCreateSchema = z.object({
  discordUserId: z.string(),
  discordUsername: z.string().optional(),
  name: z.string().min(1).optional(),
});

const discordContextActivateSchema = z.object({
  discordUserId: z.string(),
  discordUsername: z.string().optional(),
});

const normalizeStringArray = (value: unknown) =>
  Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];

const normalizeKnownUsers = (value: unknown) =>
  Array.isArray(value)
    ? value.filter(
        (item) =>
          item &&
          typeof item === 'object' &&
          typeof (item as { id?: unknown }).id === 'string' &&
          typeof (item as { username?: unknown }).username === 'string'
      )
    : [];

const normalizeUsername = (value: string) => value.trim().toLowerCase();

async function resolveDiscordChannel(
  db: ReturnType<typeof getDb>,
  discordUserId: string,
  discordUsername?: string
) {
  const normalizedDiscordUsername = discordUsername ? normalizeUsername(discordUsername) : '';
  const normalizedDiscordUsernameBase = normalizedDiscordUsername.split('#')[0];

  // Check bot DM allowlist channels for this Discord user ID or username.
  const botChannels = await db
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.type, 'discord'),
        sql`COALESCE(${channels.config} ->> 'mode', '') = 'bot_dm'`
      )
    );

  for (const channel of botChannels) {
    const config = (channel.config || {}) as Record<string, unknown>;
    const allowedIds = normalizeStringArray(config.allowedDiscordUserIds);
    const allowedUsernames = normalizeStringArray(config.allowedDiscordUsernames).map((name) =>
      normalizeUsername(name)
    );

    const allowedById = allowedIds.includes(discordUserId);
    const allowedByUsername = normalizedDiscordUsername
      ? allowedUsernames.some((allowed) => {
          if (allowed === normalizedDiscordUsername) return true;
          if (allowed.includes('#')) return false;
          return allowed === normalizedDiscordUsernameBase;
        })
      : false;

    if (!allowedById && !allowedByUsername) continue;

    const knownUsers = normalizeKnownUsers(config.knownDiscordUsers) as Array<{
      id: string;
      username: string;
      avatar?: string | null;
      lastSeenAt?: string;
    }>;

    const knownUserIndex = knownUsers.findIndex((user) => user.id === discordUserId);
    if (knownUserIndex >= 0) {
      knownUsers[knownUserIndex] = {
        ...knownUsers[knownUserIndex],
        username: discordUsername ?? knownUsers[knownUserIndex]?.username ?? '',
        lastSeenAt: new Date().toISOString(),
      };
    } else if (discordUsername) {
      knownUsers.push({
        id: discordUserId,
        username: discordUsername,
        lastSeenAt: new Date().toISOString(),
      });
    }

    if (allowedByUsername && !allowedById) {
      allowedIds.push(discordUserId);
    }

    const nextConfig = {
      ...config,
      allowedDiscordUserIds: allowedIds,
      allowedDiscordUsernames: normalizeStringArray(config.allowedDiscordUsernames),
      knownDiscordUsers: knownUsers,
    };

    await db
      .update(channels)
      .set({ config: nextConfig as any, updatedAt: new Date() })
      .where(eq(channels.id, channel.id));

    return channel;
  }

  // Fall back to connected Discord accounts
  const [connection] = await db
    .select()
    .from(discordConnections)
    .where(eq(discordConnections.discordUserId, discordUserId))
    .limit(1);

  if (!connection) {
    return null;
  }

  const [channel] = await db
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.userId, connection.userId),
        eq(channels.type, 'discord'),
        eq(channels.config, { discordUserId } as any)
      )
    )
    .limit(1);

  if (channel) {
    return channel;
  }

  const [created] = await db
    .insert(channels)
    .values({
      id: randomUUID(),
      userId: connection.userId,
      type: 'discord',
      name: `Discord - ${discordUsername ?? discordUserId}`,
      config: { discordUserId } as any,
      enabled: true,
    })
    .returning();

  return created ?? null;
}

function requireGatewayToken(req: { headers: Record<string, unknown> }, reply: any) {
  if (!config.deliveryToken) {
    reply.status(500).send({ error: 'Delivery token not configured' });
    return false;
  }
  const token = req.headers['x-delivery-token'];
  if (!token || token !== config.deliveryToken) {
    reply.status(401).send({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

export async function discordRoutes(app: FastifyInstance) {
  // OAuth callback
  app.post('/api/discord/oauth/callback', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const body = connectDiscordSchema.parse(req.body);

    // TODO: Exchange code for access token with Discord API
    // For now, mock response
    const discordUser = {
      id: '123456789',
      username: 'DemoUser#0000',
      avatar: 'avatar_hash',
    };

    const db = getDb();

    // Save or update connection
    const [connection] = await db
      .insert(discordConnections)
      .values({
        id: randomUUID(),
        userId,
        discordUserId: discordUser.id,
        discordUsername: discordUser.username,
        discordAvatar: discordUser.avatar,
      })
      .onConflictDoUpdate({
        target: [discordConnections.userId, discordConnections.discordUserId],
        set: {
          discordUsername: discordUser.username,
          discordAvatar: discordUser.avatar,
          updatedAt: new Date(),
        },
      })
      .returning();

    return { connection };
  });

  // List Discord connections
  app.get('/api/discord/connections', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const db = getDb();
    const connections = await db
      .select()
      .from(discordConnections)
      .where(eq(discordConnections.userId, userId));

    return { connections };
  });

  // Incoming Discord message webhook
  app.post('/api/discord/webhook', async (req, reply) => {
    const body = discordEventSchema.parse(req.body);
    const db = getDb();
    const normalizedDiscordUsername = normalizeUsername(body.discordUsername);
    const normalizedDiscordUsernameBase = normalizedDiscordUsername.split('#')[0];

    // Check bot DM allowlist channels for this Discord user ID or username.
    const botChannels = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.type, 'discord'),
          sql`COALESCE(${channels.config} ->> 'mode', '') = 'bot_dm'`
        )
      );

    let allowlistedChannel: (typeof botChannels)[number] | null = null;
    let shouldPersistConfig = false;
    let nextConfig: Record<string, unknown> | null = null;

    for (const channel of botChannels) {
      const config = (channel.config || {}) as Record<string, unknown>;
      const allowedIds = normalizeStringArray(config.allowedDiscordUserIds);
      const allowedUsernames = normalizeStringArray(config.allowedDiscordUsernames).map((name) =>
        normalizeUsername(name)
      );

      const allowedById = allowedIds.includes(body.discordUserId);
      const allowedByUsername = allowedUsernames.some((allowed) => {
        if (allowed === normalizedDiscordUsername) return true;
        if (allowed.includes('#')) return false;
        return allowed === normalizedDiscordUsernameBase;
      });

      if (!allowedById && !allowedByUsername) continue;

      allowlistedChannel = channel;

      const knownUsers = normalizeKnownUsers(config.knownDiscordUsers) as Array<{
        id: string;
        username: string;
        avatar?: string | null;
        lastSeenAt?: string;
      }>;

      const knownUserIndex = knownUsers.findIndex((user) => user.id === body.discordUserId);
      if (knownUserIndex >= 0) {
        knownUsers[knownUserIndex] = {
          ...knownUsers[knownUserIndex],
          username: body.discordUsername,
          avatar: body.discordAvatar ?? knownUsers[knownUserIndex]?.avatar ?? null,
          lastSeenAt: new Date().toISOString(),
        };
      } else {
        knownUsers.push({
          id: body.discordUserId,
          username: body.discordUsername,
          avatar: body.discordAvatar ?? null,
          lastSeenAt: new Date().toISOString(),
        });
      }

      if (allowedByUsername && !allowedById) {
        allowedIds.push(body.discordUserId);
      }

      nextConfig = {
        ...config,
        allowedDiscordUserIds: allowedIds,
        allowedDiscordUsernames: normalizeStringArray(config.allowedDiscordUsernames),
        knownDiscordUsers: knownUsers,
      };
      shouldPersistConfig = true;
      break;
    }

    if (allowlistedChannel) {
      const messageId = randomUUID();
      const activeContext = await ensureActiveContext(db, allowlistedChannel);
      const contextId = activeContext?.id ?? allowlistedChannel.activeContextId ?? null;

      await db.insert(messages).values({
        id: messageId,
        userId: allowlistedChannel.userId,
        channelId: allowlistedChannel.id,
        contextId,
        content: body.content,
        direction: 'inbound',
        deliveryStatus: 'delivered',
        deliveredAt: new Date(),
        metadata: JSON.stringify({
          discordMessageId: body.messageId,
          discordChannelId: body.channelId,
          discordUserId: body.discordUserId,
          discordUsername: body.discordUsername,
          discordAvatar: body.discordAvatar ?? null,
        }),
      });

      if (contextId) {
        await db
          .update(contexts)
          .set({ lastUserInteractionAt: new Date(), updatedAt: new Date() })
          .where(eq(contexts.id, contextId));
      }

      await enqueueMessage({
        type: 'message',
        messageId,
      });

      if (shouldPersistConfig && nextConfig) {
        await db
          .update(channels)
          .set({ config: nextConfig as any, updatedAt: new Date() })
          .where(eq(channels.id, allowlistedChannel.id));
      }

      app.log.info(
        { channelId: allowlistedChannel.id, discordUserId: body.discordUserId },
        'Discord message received (allowlisted)'
      );

      return { success: true };
    }

    // Fall back to connected Discord accounts
    const [connection] = await db
      .select()
      .from(discordConnections)
      .where(eq(discordConnections.discordUserId, body.discordUserId))
      .limit(1);

    if (!connection) {
      app.log.warn({ discordUserId: body.discordUserId }, 'Discord user not connected or allowed');
      if (botChannels.length === 0) {
        return reply.status(404).send({ error: 'Discord bot not configured' });
      }
      return reply.status(403).send({ error: 'User not allowed' });
    }

    // Find or create Discord channel for this user
    const [channel] = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.userId, connection.userId),
          eq(channels.type, 'discord'),
          eq(channels.config, { discordUserId: body.discordUserId } as any)
        )
      )
      .limit(1);

    let channelId = channel?.id;
    let resolvedChannel = channel ?? null;

    if (!channel) {
      const [newChannel] = await db
        .insert(channels)
        .values({
          id: randomUUID(),
          userId: connection.userId,
          type: 'discord',
          name: `Discord - ${body.discordUsername}`,
          config: { discordUserId: body.discordUserId } as any,
          enabled: true,
        })
        .returning();
      channelId = newChannel?.id;
      resolvedChannel = newChannel ?? null;
    }

    if (!channelId) {
      return reply.status(500).send({ error: 'Failed to create channel' });
    }

    // Save message
    const messageId = randomUUID();
    const activeContext =
      resolvedChannel && channelId
        ? await ensureActiveContext(db, {
            id: channelId,
            userId: connection.userId,
            activeContextId: resolvedChannel.activeContextId ?? null,
          })
        : null;
    const contextId = activeContext?.id ?? resolvedChannel?.activeContextId ?? null;

    await db.insert(messages).values({
      id: messageId,
      userId: connection.userId,
      channelId,
      contextId,
      content: body.content,
      direction: 'inbound',
      deliveryStatus: 'delivered',
      deliveredAt: new Date(),
      metadata: JSON.stringify({
        discordMessageId: body.messageId,
        discordChannelId: body.channelId,
        discordUserId: body.discordUserId,
        discordUsername: body.discordUsername,
        discordAvatar: body.discordAvatar ?? null,
      }),
    });

    if (contextId) {
      await db
        .update(contexts)
        .set({ lastUserInteractionAt: new Date(), updatedAt: new Date() })
        .where(eq(contexts.id, contextId));
    }

    await enqueueMessage({
      type: 'message',
      messageId,
    });

    app.log.info({ channelId, discordUserId: body.discordUserId }, 'Discord message received');

    return { success: true };
  });

  // List contexts for Discord user
  app.get('/api/discord/contexts', async (req, reply) => {
    if (!requireGatewayToken(req as { headers: Record<string, unknown> }, reply)) {
      return;
    }

    const query = discordContextQuerySchema.parse(req.query);
    const db = getDb();
    const channel = await resolveDiscordChannel(db, query.discordUserId, query.discordUsername);

    if (!channel) {
      return reply.status(403).send({ error: 'Discord user not connected or allowed' });
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

  // Create a new context for Discord user
  app.post('/api/discord/contexts', async (req, reply) => {
    if (!requireGatewayToken(req as { headers: Record<string, unknown> }, reply)) {
      return;
    }

    const body = discordContextCreateSchema.parse(req.body);
    const db = getDb();
    const channel = await resolveDiscordChannel(db, body.discordUserId, body.discordUsername);

    if (!channel) {
      return reply.status(403).send({ error: 'Discord user not connected or allowed' });
    }

    if (channel.activeContextId) {
      const [activeContext] = await db
        .select()
        .from(contexts)
        .where(eq(contexts.id, channel.activeContextId))
        .limit(1);

      if (activeContext && !activeContext.closedAt) {
        await db
          .update(contexts)
          .set({ closedAt: new Date(), updatedAt: new Date() })
          .where(eq(contexts.id, activeContext.id));

        await enqueueMemoryWrite({
          type: 'memory_write',
          contextId: activeContext.id,
          userId: activeContext.userId,
          mode: 'close',
        });
      }
    }

    const created = await createContext(db, channel, body.name);

    return {
      context: created,
      activeContextId: created?.id ?? channel.activeContextId ?? null,
    };
  });

  // Activate a context for Discord user
  app.post<{ Params: { id: string } }>('/api/discord/contexts/:id/activate', async (req, reply) => {
    if (!requireGatewayToken(req as { headers: Record<string, unknown> }, reply)) {
      return;
    }

    const { id } = req.params;
    const body = discordContextActivateSchema.parse(req.body);
    const db = getDb();
    const channel = await resolveDiscordChannel(db, body.discordUserId, body.discordUsername);

    if (!channel) {
      return reply.status(403).send({ error: 'Discord user not connected or allowed' });
    }

    const [context] = await db
      .select()
      .from(contexts)
      .where(and(eq(contexts.id, id), eq(contexts.channelId, channel.id)))
      .limit(1);

    if (!context) {
      return reply.status(404).send({ error: 'Context not found' });
    }

    await db
      .update(channels)
      .set({ activeContextId: context.id, updatedAt: new Date() })
      .where(eq(channels.id, channel.id));

    return { activeContextId: context.id };
  });
}
