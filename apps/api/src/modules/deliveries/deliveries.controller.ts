import type { FastifyInstance } from 'fastify';
import { getDb, messages } from '@clifford/db';
import { eq } from 'drizzle-orm';
import { ackSchema } from './deliveries.schema.js';
import { requireDeliveryToken } from './deliveries.service.js';

export async function deliveryRoutes(app: FastifyInstance) {
  app.post('/api/deliveries/ack', async (req, reply) => {
    if (!requireDeliveryToken(req, reply)) return;

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
