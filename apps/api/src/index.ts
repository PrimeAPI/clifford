import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { healthRoutes } from './routes/health.js';
import { runRoutes } from './routes/runs.js';
import { eventRoutes } from './routes/events.js';
import { channelRoutes } from './routes/channels.js';
import { messageRoutes } from './routes/messages.js';
import { discordRoutes } from './routes/discord.js';
import { settingsRoutes } from './routes/settings.js';
import { queueRoutes } from './routes/queue.js';
import { deliveryRoutes } from './routes/deliveries.js';

const app = Fastify({
  logger: {
    level: config.logLevel,
  },
});

await app.register(cors);
await app.register(healthRoutes);
await app.register(runRoutes);
await app.register(eventRoutes);
await app.register(channelRoutes);
await app.register(messageRoutes);
await app.register(discordRoutes);
await app.register(settingsRoutes);
await app.register(queueRoutes);
await app.register(deliveryRoutes);

const start = async () => {
  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`API server listening on http://${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
