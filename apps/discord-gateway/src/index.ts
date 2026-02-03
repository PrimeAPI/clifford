import { Client, GatewayIntentBits, Events, Partials } from 'discord.js';
import { Worker } from 'bullmq';
import pino from 'pino';
import { config } from './config.js';

const logger = pino({ level: config.logLevel });

if (!config.discordBotToken) {
  logger.warn('DISCORD_BOT_TOKEN not set, Discord gateway disabled');
  process.exit(0);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

const connection = {
  url: config.redisUrl,
};

let deliveryWorker: Worker | null = null;

const startDeliveryWorker = () => {
  if (deliveryWorker) return;

  deliveryWorker = new Worker(
    'clifford-deliveries',
    async (job) => {
      if (!config.deliveryToken) {
        throw new Error('DELIVERY_TOKEN not configured');
      }

      const { provider, payload, messageId } = job.data as {
        provider?: string;
        payload?: { discordUserId?: string; content?: string };
        messageId?: string;
      };

      if (provider !== 'discord') {
        throw new Error(`Unsupported delivery provider: ${provider ?? 'unknown'}`);
      }

      const discordUserId = payload?.discordUserId;
      const content = payload?.content;

      if (!discordUserId || !content || !messageId) {
        throw new Error('Missing Discord delivery payload');
      }

      const user = await client.users.fetch(discordUserId);
      await user.send(content);

      const ackResponse = await fetch(`${config.apiUrl}/api/deliveries/ack`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Delivery-Token': config.deliveryToken,
        },
        body: JSON.stringify({ messageId, status: 'delivered' }),
      });

      if (!ackResponse.ok) {
        const errorText = await ackResponse.text();
        throw new Error(`Delivery ack failed: ${ackResponse.status} ${errorText}`);
      }

      logger.info({ messageId }, 'Discord delivery completed');
    },
    {
      connection,
      concurrency: 5,
    }
  );
};

client.on('ready', () => {
  logger.info({ user: client.user?.tag }, 'Discord bot connected');
  startDeliveryWorker();
});

client.on(Events.MessageCreate, async (message) => {
  // Ignore bot messages
  if (message.author.bot) return;

  // Only handle DMs or mentions
  const isDM = message.channel.isDMBased();
  const isMentioned = message.mentions.users.has(client.user?.id || '');

  if (!isDM && !isMentioned) return;

  const content = isDM ? message.content : message.content.replace(`<@${client.user?.id}>`, '').trim();

  await message.channel.sendTyping();

  if (isDM) {
    const lowerContent = content.trim().toLowerCase();
    if (lowerContent === 'id' || lowerContent === '!id' || lowerContent === 'whoami') {
      await message.reply(
        `Your Discord user ID is ${message.author.id} (username: ${message.author.username}#${message.author.discriminator}).`
      );
      return;
    }
  }

  logger.info(
    {
      userId: message.author.id,
      username: message.author.username,
      channelId: message.channelId,
      messageId: message.id,
      isDM,
    },
    'Received Discord message'
  );

  // Forward to API webhook
  try {
    const response = await fetch(`${config.apiUrl}/api/discord/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        discordUserId: message.author.id,
        discordUsername: `${message.author.username}#${message.author.discriminator}`,
        discordAvatar: message.author.avatar,
        content,
        channelId: message.channelId,
        messageId: message.id,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error({ status: response.status, error }, 'Failed to forward Discord message');

      // Notify user if not connected
      if (response.status === 403) {
        await message.reply(
          '⛔ You are not allowed to send DMs to this bot. Please ask the owner to allow your Discord user ID.'
        );
      } else if (response.status === 404) {
        await message.reply(
          '⚠️ This bot is not configured to accept DMs yet. Please ask the owner to enable Discord DMs.'
        );
      }
    }
  } catch (err) {
    logger.error({ err }, 'Error forwarding Discord message');
    await message.reply('❌ An error occurred. Please try again later.');
  }
});

client.login(config.discordBotToken);

logger.info('Discord gateway starting');

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down');
  if (deliveryWorker) {
    await deliveryWorker.close();
  }
  client.destroy();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down');
  if (deliveryWorker) {
    await deliveryWorker.close();
  }
  client.destroy();
  process.exit(0);
});
