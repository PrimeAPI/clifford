import { Client, GatewayIntentBits, Events, Partials } from 'discord.js';
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

client.on('ready', () => {
  logger.info({ user: client.user?.tag }, 'Discord bot connected');
});

client.on(Events.MessageCreate, async (message) => {
  // Ignore bot messages
  if (message.author.bot) return;

  // Only handle DMs or mentions
  const isDM = message.channel.isDMBased();
  const isMentioned = message.mentions.users.has(client.user?.id || '');

  if (!isDM && !isMentioned) return;

  const content = isDM ? message.content : message.content.replace(`<@${client.user?.id}>`, '').trim();

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
    } else {
      // Acknowledge receipt
      await message.react('✅');
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
  client.destroy();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down');
  client.destroy();
  process.exit(0);
});
