import { pgTable, text, timestamp, uuid, jsonb, unique } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const notificationOutbox = pgTable(
  'notification_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(), // discord|email|webhook
    payloadJson: jsonb('payload_json').notNull(),
    dedupeKey: text('dedupe_key'),
    status: text('status').notNull().default('pending'), // pending|sent|failed
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    dedupeUnique: unique().on(table.tenantId, table.dedupeKey),
  })
);

export type NotificationOutbox = typeof notificationOutbox.$inferSelect;
export type NewNotificationOutbox = typeof notificationOutbox.$inferInsert;
