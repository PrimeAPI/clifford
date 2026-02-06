import { randomUUID } from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, channels, discordConnections } from '@clifford/db';
import { config } from '../../config.js';

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

export async function resolveDiscordChannel(
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
      and(eq(channels.type, 'discord'), sql`COALESCE(${channels.config} ->> 'mode', '') = 'bot_dm'`)
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

export function requireGatewayToken(req: { headers: Record<string, unknown> }, reply: any) {
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

export function normalizeDiscordUsername(value: string) {
  return normalizeUsername(value);
}

export function normalizeDiscordStringArray(value: unknown) {
  return normalizeStringArray(value);
}

export function normalizeDiscordKnownUsers(value: unknown) {
  return normalizeKnownUsers(value);
}
