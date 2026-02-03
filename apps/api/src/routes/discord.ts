import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, discordConnections, channels, messages } from '@clifford/db';
import { eq, and, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';

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
      await db.insert(messages).values({
        id: randomUUID(),
        userId: allowlistedChannel.userId,
        channelId: allowlistedChannel.id,
        content: body.content,
        direction: 'inbound',
        metadata: JSON.stringify({
          discordMessageId: body.messageId,
          discordChannelId: body.channelId,
          discordUserId: body.discordUserId,
          discordUsername: body.discordUsername,
          discordAvatar: body.discordAvatar ?? null,
        }),
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
    }

    if (!channelId) {
      return reply.status(500).send({ error: 'Failed to create channel' });
    }

    // Save message
    await db.insert(messages).values({
      id: randomUUID(),
      userId: connection.userId,
      channelId,
      content: body.content,
      direction: 'inbound',
      metadata: JSON.stringify({
        discordMessageId: body.messageId,
        discordChannelId: body.channelId,
        discordUserId: body.discordUserId,
        discordUsername: body.discordUsername,
        discordAvatar: body.discordAvatar ?? null,
      }),
    });

    app.log.info({ channelId, discordUserId: body.discordUserId }, 'Discord message received');

    return { success: true };
  });
}
