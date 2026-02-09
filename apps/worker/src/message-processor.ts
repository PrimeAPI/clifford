import type { Job } from 'bullmq';
import type { MessageJob, Logger } from '@clifford/sdk';
import {
  getDb,
  messages,
  channels,
  userSettings,
  users,
  contexts,
  memoryItems,
} from '@clifford/db';
import { eq, and, desc, ne, asc, inArray, sql, isNull } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { config } from './config.js';
import { enqueueDelivery, enqueueMemoryWrite } from './queues.js';
import { decryptSecret } from '@clifford/core';
import { callOpenAIWithFallback, type OpenAIMessage } from './openai-client.js';

const DEFAULT_SYSTEM_PROMPT = 'You are Clifford, a very skilled and highly complex AI-Assistent!';
const CROSS_CHANNEL_MESSAGE_LIMIT = 12;

interface DiscordMetadata {
  discordUserId?: string;
}

export async function processMessage(job: Job<MessageJob>, logger: Logger) {
  const { messageId } = job.data;
  const db = getDb();

  const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!message) {
    logger.warn({ messageId }, 'Message not found');
    return;
  }

  if (message.direction !== 'inbound') {
    return;
  }

  const [channel] = await db
    .select()
    .from(channels)
    .where(eq(channels.id, message.channelId))
    .limit(1);

  if (!channel) {
    logger.warn({ messageId, channelId: message.channelId }, 'Channel not found');
    return;
  }

  try {
    const [settings] = await db
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, message.userId))
      .limit(1);

    if (!settings || !settings.llmApiKeyEncrypted) {
      await db.insert(messages).values({
        id: randomUUID(),
        userId: message.userId,
        channelId: message.channelId,
        content: 'Please add your OpenAI API key in Settings to enable responses.',
        direction: 'outbound',
      });
      return;
    }

    if (!settings.llmApiKeyIv || !settings.llmApiKeyTag) {
      throw new Error('LLM API key is missing encryption metadata');
    }

    if (!config.encryptionKey) {
      throw new Error('DATA_ENCRYPTION_KEY not configured for worker');
    }

    const apiKey = decryptSecret(
      settings.llmApiKeyEncrypted,
      settings.llmApiKeyIv,
      settings.llmApiKeyTag,
      config.encryptionKey
    ).trim();

    if (!apiKey.startsWith('sk-')) {
      throw new Error('OpenAI API key appears invalid (must start with \"sk-\")');
    }

    const provider = settings.llmProvider || 'openai';
    const model = settings.llmModel || 'gpt-4o-mini';
    const fallbackModel = settings.llmFallbackModel || null;

    const [user] = await db.select().from(users).where(eq(users.id, message.userId)).limit(1);
    const contextId = message.contextId ?? channel.activeContextId ?? null;
    const [context] = contextId
      ? await db
          .select()
          .from(contexts)
          .where(and(eq(contexts.id, contextId), eq(contexts.channelId, channel.id)))
          .limit(1)
      : [null];

    const history = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.channelId, channel.id),
          contextId ? eq(messages.contextId, contextId) : isNull(messages.contextId)
        )
      )
      .orderBy(desc(messages.createdAt))
      .limit(40);

    const historyOrdered = history.reverse();

    const crossChannelBlocks: OpenAIMessage[] = [];
    const crossChannelEnabled = settings.crossChannelContextEnabled ?? true;
    const crossChannelLimit = settings.crossChannelContextLimit ?? CROSS_CHANNEL_MESSAGE_LIMIT;

    if (crossChannelEnabled) {
      const otherChannels = await db
        .select()
        .from(channels)
        .where(and(eq(channels.userId, message.userId), ne(channels.id, channel.id)));

      for (const other of otherChannels) {
        if (!other.activeContextId) continue;

        const otherMessages = await db
          .select()
          .from(messages)
          .where(
            and(eq(messages.channelId, other.id), eq(messages.contextId, other.activeContextId))
          )
          .orderBy(desc(messages.createdAt))
          .limit(crossChannelLimit);

        if (otherMessages.length === 0) continue;

        const ordered = otherMessages.reverse();
        const transcript = ordered
          .map(
            (entry) => `${entry.direction === 'inbound' ? 'User' : 'Clifford'}: ${entry.content}`
          )
          .join('\n');

        crossChannelBlocks.push({
          role: 'system',
          content: `Active context in ${other.type} (${other.name}):\n${transcript}`,
        });
      }
    }

    const systemPrompt = settings.defaultSystemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;
    const systemInfoLines = [
      `User name: ${user?.name ?? 'Unknown'}`,
      `Channel: ${channel.type}`,
      `Context: ${context?.name ?? 'Default'}`,
    ];

    const memoryBlock =
      settings.memoryEnabled === false ? '' : await buildMemoryBlock(db, message.userId);

    const conversation: OpenAIMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'system', content: systemInfoLines.join('\n') },
      ...(memoryBlock ? [{ role: 'system' as const, content: memoryBlock }] : []),
      ...crossChannelBlocks,
      ...historyOrdered.map((entry) => ({
        role: (entry.direction === 'inbound' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: entry.content,
      })),
    ];

    let responseText = '';

    if (provider === 'openai') {
      responseText = await callOpenAIWithFallback(apiKey, model, fallbackModel, conversation);
    } else {
      throw new Error(`Unsupported LLM provider: ${provider}`);
    }

    const [outbound] = await db
      .insert(messages)
      .values({
        id: randomUUID(),
        userId: message.userId,
        channelId: message.channelId,
        contextId: message.contextId ?? channel.activeContextId ?? null,
        content: responseText,
        direction: 'outbound',
        deliveryStatus: channel.type === 'web' ? 'delivered' : 'pending',
        deliveredAt: channel.type === 'web' ? new Date() : null,
        metadata: JSON.stringify({
          provider,
          model,
          replyTo: message.id,
        }),
      })
      .returning();

    if (!outbound) {
      throw new Error('Failed to create outbound message');
    }

    if (channel.type === 'discord') {
      let discordUserId: string | undefined;

      const configValue = channel.config as { discordUserId?: string } | null;
      if (configValue?.discordUserId) {
        discordUserId = configValue.discordUserId;
      }

      if (!discordUserId && message.metadata) {
        try {
          const meta = JSON.parse(message.metadata) as DiscordMetadata;
          discordUserId = meta.discordUserId;
        } catch {
          discordUserId = undefined;
        }
      }

      if (discordUserId) {
        await enqueueDelivery({
          type: 'delivery',
          provider: 'discord',
          messageId: outbound.id,
          payload: {
            discordUserId,
            content: responseText,
          },
        });
      } else {
        throw new Error('Discord user ID missing; cannot send DM');
      }
    }

    if (contextId) {
      await updateContextAfterResponse({
        db,
        contextId,
        userId: message.userId,
        logger,
      });
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error({ messageId, err }, 'Message processing failed');

    const fallback = `Error while processing your request: ${errorMessage}`;

    const [outbound] = await db
      .insert(messages)
      .values({
        id: randomUUID(),
        userId: message.userId,
        channelId: message.channelId,
        contextId: message.contextId ?? channel.activeContextId ?? null,
        content: fallback,
        direction: 'outbound',
        deliveryStatus: channel.type === 'web' ? 'delivered' : 'pending',
        deliveredAt: channel.type === 'web' ? new Date() : null,
        metadata: JSON.stringify({
          error: true,
          replyTo: message.id,
        }),
      })
      .returning();

    if (channel.type === 'discord') {
      let discordUserId: string | undefined;

      const configValue = channel.config as { discordUserId?: string } | null;
      if (configValue?.discordUserId) {
        discordUserId = configValue.discordUserId;
      }

      if (!discordUserId && message.metadata) {
        try {
          const meta = JSON.parse(message.metadata) as DiscordMetadata;
          discordUserId = meta.discordUserId;
        } catch {
          discordUserId = undefined;
        }
      }

      if (discordUserId && outbound) {
        await enqueueDelivery({
          type: 'delivery',
          provider: 'discord',
          messageId: outbound.id,
          payload: {
            discordUserId,
            content: fallback,
          },
        });
      }
    }

    const catchContextId = message.contextId ?? channel.activeContextId ?? null;
    if (catchContextId) {
      await updateContextAfterResponse({
        db,
        contextId: catchContextId,
        userId: message.userId,
        logger,
      });
    }
  }
}

const MEMORY_LOAD_CAP = 1200;
const MEMORY_PER_LEVEL_LIMIT = 5;

const MEMORY_LEVEL_LIMITS = [
  { level: 0, maxItems: 4, maxChars: 50 },
  { level: 1, maxItems: 8, maxChars: 120 },
  { level: 2, maxItems: 10, maxChars: 180 },
  { level: 3, maxItems: 12, maxChars: 200 },
  { level: 4, maxItems: 12, maxChars: 240 },
  { level: 5, maxItems: 6, maxChars: 300 },
];

async function buildMemoryBlock(db: ReturnType<typeof getDb>, userId: string) {
  const items = await db
    .select()
    .from(memoryItems)
    .where(and(eq(memoryItems.userId, userId), eq(memoryItems.archived, false)));

  if (items.length === 0) {
    return '';
  }

  const byLevel = new Map<number, typeof items>();
  for (const item of items) {
    const list = byLevel.get(item.level) ?? [];
    list.push(item);
    byLevel.set(item.level, list);
  }

  for (const list of byLevel.values()) {
    list.sort((a, b) => (b.lastSeenAt?.getTime?.() ?? 0) - (a.lastSeenAt?.getTime?.() ?? 0));
  }

  const selected: typeof items = [];
  for (const level of [0, 1, 2, 3, 4, 5]) {
    const list = byLevel.get(level) ?? [];
    selected.push(...list.slice(0, MEMORY_PER_LEVEL_LIMIT));
  }

  let totalChars = 0;
  const lines: string[] = [];
  for (const item of selected) {
    const maxChars = maxCharsForLevel(item.level);
    const value = item.value.length > maxChars ? item.value.slice(0, maxChars) : item.value;
    const line = `- ${item.module}.${item.key}: ${value}`;

    if (totalChars + line.length > MEMORY_LOAD_CAP) {
      break;
    }

    lines.push(line);
    totalChars += line.length;
  }

  if (lines.length === 0) {
    return '';
  }

  return `Active memory:\n${lines.join('\n')}`;
}

function maxCharsForLevel(level: number) {
  return MEMORY_LEVEL_LIMITS.find((limit) => limit.level === level)?.maxChars ?? 120;
}

async function updateContextAfterResponse({
  db,
  contextId,
  userId,
  logger,
}: {
  db: ReturnType<typeof getDb>;
  contextId: string;
  userId: string;
  logger: Logger;
}) {
  const [context] = await db.select().from(contexts).where(eq(contexts.id, contextId)).limit(1);
  if (!context || context.closedAt) {
    return;
  }

  const [updated] = await db
    .update(contexts)
    .set({ turnCount: sql`${contexts.turnCount} + 1`, updatedAt: new Date() })
    .where(eq(contexts.id, contextId))
    .returning();

  if (!updated) {
    return;
  }

  if (updated.turnCount > config.maxTurnsPerContext) {
    await compactContext({ db, contextId, userId, logger });
  }
}

async function compactContext({
  db,
  contextId,
  userId,
  logger,
}: {
  db: ReturnType<typeof getDb>;
  contextId: string;
  userId: string;
  logger: Logger;
}) {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.contextId, contextId))
    .orderBy(asc(messages.createdAt));

  if (rows.length < 2) {
    return;
  }

  const midpoint = Math.floor(rows.length / 2);
  const older = rows.slice(0, midpoint);
  const newer = rows.slice(midpoint);

  if (older.length === 0 || newer.length === 0) {
    return;
  }

  const segmentMessages = older.slice(-config.memoryWriterMaxMessages).map((entry) => ({
    direction: entry.direction as 'inbound' | 'outbound',
    content: entry.content,
    createdAt: entry.createdAt?.toISOString?.() ?? undefined,
  }));

  await enqueueMemoryWrite({
    type: 'memory_write',
    contextId,
    userId,
    mode: 'compact',
    segmentMessages,
  });

  const olderIds = older.map((entry) => entry.id);
  if (olderIds.length > 0) {
    await db.delete(messages).where(inArray(messages.id, olderIds));
  }

  // Count remaining inbound messages as turns (each inbound triggers one turnCount increment)
  const newTurnCount = newer.filter((entry) => entry.direction === 'inbound').length;
  // Note: turnCount is incremented once per inbound message processing cycle (updateContextAfterResponse)
  await db
    .update(contexts)
    .set({ turnCount: newTurnCount, updatedAt: new Date() })
    .where(eq(contexts.id, contextId));

  logger.info({ contextId, removed: older.length }, 'Context compacted');
}
