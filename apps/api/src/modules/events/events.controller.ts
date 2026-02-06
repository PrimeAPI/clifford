import type { FastifyInstance } from 'fastify';
import { discordEventSchema } from './events.schema.js';
import { logDiscordEvent } from './events.service.js';

export async function eventRoutes(app: FastifyInstance) {
  app.post('/api/events/discord', async (req, reply) => {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return reply.status(400).send({ error: 'Missing X-Tenant-Id header' });
    }

    const body = discordEventSchema.parse(req.body);

    // TODO: persist event, enqueue DiscordEventJob
    logDiscordEvent(app.log, { tenantId, ...body });

    return { ok: true };
  });
}
