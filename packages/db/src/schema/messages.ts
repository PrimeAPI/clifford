import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';
import { channels } from './channels';

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  channelId: uuid('channel_id')
    .notNull()
    .references(() => channels.id, { onDelete: 'cascade' }),
  contextId: uuid('context_id'),
  content: text('content').notNull(),
  direction: text('direction').notNull().default('inbound'), // inbound|outbound
  metadata: text('metadata'), // JSON string for additional data
  deliveryStatus: text('delivery_status').notNull().default('delivered'), // pending|delivered|failed
  deliveryError: text('delivery_error'),
  deliveredAt: timestamp('delivered_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
