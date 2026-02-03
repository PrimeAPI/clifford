import type { Job } from 'bullmq';
import type { MessageJob, Logger } from '@clifford/sdk';
import { getDb, messages, channels, userSettings } from '@clifford/db';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { config } from './config.js';
import { enqueueDelivery } from './queues.js';
import { decryptSecret } from './crypto.js';
import { callOpenAI } from './openai-client.js';

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

    let responseText = '';

    if (provider === 'openai') {
      responseText = await callOpenAI(apiKey, model, message.content);
    } else {
      throw new Error(`Unsupported LLM provider: ${provider}`);
    }

    const [outbound] = await db
      .insert(messages)
      .values({
        id: randomUUID(),
        userId: message.userId,
        channelId: message.channelId,
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
  }
}
