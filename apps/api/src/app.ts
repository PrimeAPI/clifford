import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { healthRoutes } from './modules/health/health.controller.js';
import { runRoutes } from './modules/runs/runs.controller.js';
import { eventRoutes } from './modules/events/events.controller.js';
import { channelRoutes } from './modules/channels/channels.controller.js';
import { messageRoutes } from './modules/messages/messages.controller.js';
import { contextRoutes } from './modules/contexts/contexts.controller.js';
import { discordRoutes } from './modules/discord/discord.controller.js';
import { discordOutboxRoutes } from './modules/discord-outbox/discord-outbox.controller.js';
import { settingsRoutes } from './modules/settings/settings.controller.js';
import { queueRoutes } from './modules/queue/queue.controller.js';
import { deliveryRoutes } from './modules/deliveries/deliveries.controller.js';
import { memoryRoutes } from './modules/memories/memories.controller.js';
import { toolRoutes } from './modules/tools/tools.controller.js';
import { policyRoutes } from './modules/policies/policies.controller.js';

export function createApp() {
  const app = Fastify({
    logger: {
      level: config.logLevel,
    },
  });

  app.register(cors);
  app.register(healthRoutes);
  app.register(runRoutes);
  app.register(eventRoutes);
  app.register(channelRoutes);
  app.register(messageRoutes);
  app.register(contextRoutes);
  app.register(discordRoutes);
  app.register(discordOutboxRoutes);
  app.register(settingsRoutes);
  app.register(memoryRoutes);
  app.register(toolRoutes);
  app.register(policyRoutes);
  app.register(queueRoutes);
  app.register(deliveryRoutes);

  return app;
}
