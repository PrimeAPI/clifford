import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { getDb, discordOutbox } from '@clifford/db';
import { ackSchema, claimSchema } from './discord-outbox.schema.js';
import { requireDiscordOutboxToken } from './discord-outbox.service.js';

export async function discordOutboxRoutes(app: FastifyInstance) {
  app.post('/api/discord/outbox/claim', async (req, reply) => {
    if (!requireDiscordOutboxToken(req, reply)) return;

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

    return { items: [...result] };
  });

  app.post('/api/discord/outbox/ack', async (req, reply) => {
    if (!requireDiscordOutboxToken(req, reply)) return;

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
