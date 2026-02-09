import { Client, GatewayIntentBits, Events, Partials, SlashCommandBuilder } from 'discord.js';
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

const contextCommands = [
  new SlashCommandBuilder()
    .setName('context-new')
    .setDescription('Create and activate a new context')
    .addStringOption((option) =>
      option.setName('name').setDescription('Optional context name').setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('context-list')
    .setDescription('List contexts available in this channel'),
  new SlashCommandBuilder()
    .setName('context-use')
    .setDescription('Activate a context by ID')
    .addStringOption((option) =>
      option.setName('context_id').setDescription('Context ID').setRequired(true)
    ),
].map((command) => command.toJSON());

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

  client.application?.commands
    .set(contextCommands)
    .then(() => {
      logger.info('Discord slash commands registered');
    })
    .catch((err) => {
      logger.error({ err }, 'Failed to register slash commands');
    });
});

client.on(Events.MessageCreate, async (message) => {
  // Ignore bot messages
  if (message.author.bot) return;

  // Only handle DMs or mentions
  const isDM = message.channel.isDMBased();
  const isMentioned = message.mentions.users.has(client.user?.id || '');

  if (!isDM && !isMentioned) return;

  const content = isDM
    ? message.content
    : message.content.replace(`<@${client.user?.id}>`, '').trim();

  if (!content.trim()) {
    await message.reply('Please include a message after mentioning me.');
    return;
  }

  if (!config.deliveryToken) {
    await message.reply(
      '⚠️ This bot is misconfigured: DELIVERY_TOKEN is missing, so I cannot deliver responses. Please ask the owner to configure it.'
    );
    return;
  }

  try {
    await message.channel.sendTyping();
  } catch (err) {
    logger.warn({ err, channelId: message.channelId }, 'Failed to send typing indicator');
  }

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
      } else if (response.status >= 500) {
        await message.reply(
          '❌ The backend failed while processing your message. Please try again shortly.'
        );
      } else {
        await message.reply(
          `❌ I could not process that message (HTTP ${response.status}). Please try again.`
        );
      }
    }
  } catch (err) {
    logger.error({ err }, 'Error forwarding Discord message');
    await message.reply('❌ An error occurred. Please try again later.');
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (!config.deliveryToken) {
    await interaction.reply({
      content: 'Discord context commands are unavailable (delivery token not configured).',
      ephemeral: true,
    });
    return;
  }

  const discordUserId = interaction.user.id;
  const discordUsername = `${interaction.user.username}#${interaction.user.discriminator}`;

  try {
    if (interaction.commandName === 'context-list') {
      await interaction.deferReply({ ephemeral: true });

      const params = new URLSearchParams({
        discordUserId,
        discordUsername,
      });

      const res = await fetch(`${config.apiUrl}/api/discord/contexts?${params.toString()}`, {
        headers: {
          'X-Delivery-Token': config.deliveryToken,
        },
      });

      if (!res.ok) {
        const errorText = await res.text();
        await interaction.editReply(`Failed to load contexts: ${res.status} ${errorText}`);
        return;
      }

      const data = (await res.json()) as {
        contexts?: Array<{ id: string; name: string }>;
        activeContextId?: string | null;
      };

      const items = data.contexts ?? [];
      if (items.length === 0) {
        await interaction.editReply('No contexts yet. Use /context-new to create one.');
        return;
      }

      const lines = items.map((context) => {
        const isActive = context.id === data.activeContextId;
        return `${isActive ? '* ' : ''}${context.name} (${context.id})`;
      });

      await interaction.editReply(lines.join('\n'));
      return;
    }

    if (interaction.commandName === 'context-new') {
      await interaction.deferReply({ ephemeral: true });
      const name = interaction.options.getString('name') ?? undefined;

      const res = await fetch(`${config.apiUrl}/api/discord/contexts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Delivery-Token': config.deliveryToken,
        },
        body: JSON.stringify({ discordUserId, discordUsername, name }),
      });

      if (!res.ok) {
        const errorText = await res.text();
        await interaction.editReply(`Failed to create context: ${res.status} ${errorText}`);
        return;
      }

      const data = (await res.json()) as { context?: { id: string; name: string } };
      if (data.context) {
        await interaction.editReply(
          `Created and activated context "${data.context.name}" (${data.context.id}).`
        );
        return;
      }

      await interaction.editReply('Context created.');
      return;
    }

    if (interaction.commandName === 'context-use') {
      await interaction.deferReply({ ephemeral: true });
      const contextId = interaction.options.getString('context_id', true);

      const res = await fetch(`${config.apiUrl}/api/discord/contexts/${contextId}/activate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Delivery-Token': config.deliveryToken,
        },
        body: JSON.stringify({ discordUserId, discordUsername }),
      });

      if (!res.ok) {
        const errorText = await res.text();
        await interaction.editReply(`Failed to activate context: ${res.status} ${errorText}`);
        return;
      }

      await interaction.editReply(`Activated context ${contextId}.`);
      return;
    }
  } catch (err) {
    logger.error({ err }, 'Discord interaction failed');
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply('An error occurred while handling that command.');
    } else {
      await interaction.reply({
        content: 'An error occurred while handling that command.',
        ephemeral: true,
      });
    }
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
