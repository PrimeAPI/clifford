import { Client, GatewayIntentBits } from 'discord.js';
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
  ],
});

client.on('ready', () => {
  logger.info({ user: client.user?.tag }, 'Discord bot connected');
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  logger.info(
    {
      channelId: message.channelId,
      messageId: message.id,
      content: message.content,
    },
    'Received Discord message'
  );

  // Forward to API
  try {
    const response = await fetch(`${config.apiUrl}/api/events/discord`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': config.tenantId,
      },
      body: JSON.stringify({
        channelId: message.channelId,
        messageId: message.id,
        content: message.content,
      }),
    });

    if (!response.ok) {
      logger.error({ status: response.status }, 'Failed to forward Discord event to API');
    }
  } catch (err) {
    logger.error({ err }, 'Error forwarding Discord event');
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
