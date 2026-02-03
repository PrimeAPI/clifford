import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { getDb, discordOutbox } from '@clifford/db';
import { config } from '../config.js';

const claimSchema = z.object({
  limit: z.number().int().min(1).max(50).optional(),
});

const ackSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['sent', 'failed']),
  error: z.string().optional(),
});

function requireToken(req: any, reply: any) {
  const token = req.headers['x-discord-outbox-token'] as string | undefined;
  if (!config.discordOutboxToken || token !== config.discordOutboxToken) {
    reply.status(401).send({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

export async function discordOutboxRoutes(app: FastifyInstance) {
  app.post('/api/discord/outbox/claim', async (req, reply) => {
    if (!requireToken(req, reply)) return;

    const body = claimSchema.parse(req.body ?? {});
    const limit = body.limit ?? 10;
    const db = getDb();

    const result = await db.execute(sql`
      UPDATE discord_outbox
      SET status = 'processing', updated_at = now()
      WHERE id IN (
        SELECT id
        FROM discord_outbox
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT ${limit}
      )
      RETURNING id, user_id, discord_user_id, content, status, created_at
    `);

    return { items: result.rows };
  });

  app.post('/api/discord/outbox/ack', async (req, reply) => {
    if (!requireToken(req, reply)) return;

    const body = ackSchema.parse(req.body);
    const db = getDb();

    await db
      .update(discordOutbox)
      .set({
        status: body.status,
        lastError: body.error ?? null,
        updatedAt: new Date(),
      })
      .where(sql`${discordOutbox.id} = ${body.id}`);

    return { success: true };
  });
}
