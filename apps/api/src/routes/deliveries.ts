import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, messages } from '@clifford/db';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';

const ackSchema = z.object({
  messageId: z.string().uuid(),
  status: z.enum(['delivered', 'failed']),
  error: z.string().optional(),
});


function requireToken(req: any, reply: any) {
  const token = req.headers['x-delivery-token'] as string | undefined;
  if (!config.deliveryToken || token !== config.deliveryToken) {
    reply.status(401).send({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

export async function deliveryRoutes(app: FastifyInstance) {
  app.post('/api/deliveries/ack', async (req, reply) => {
    if (!requireToken(req, reply)) return;

    const body = ackSchema.parse(req.body);
    const db = getDb();

    await db
      .update(messages)
      .set({
        deliveryStatus: body.status,
        deliveryError: body.error ?? null,
        deliveredAt: body.status === 'delivered' ? new Date() : null,
      })
      .where(eq(messages.id, body.messageId));

    return { success: true };
  });
}
