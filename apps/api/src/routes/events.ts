import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const discordEventSchema = z.object({
  channelId: z.string(),
  messageId: z.string(),
  content: z.string(),
});

export async function eventRoutes(app: FastifyInstance) {
  // Receive Discord events
  app.post('/api/events/discord', async (req, reply) => {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return reply.status(400).send({ error: 'Missing X-Tenant-Id header' });
    }

    const body = discordEventSchema.parse(req.body);

    // TODO: persist event, enqueue DiscordEventJob
    app.log.info({ tenantId, ...body }, 'Discord event received');

    return { ok: true };
  });
}
