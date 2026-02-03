import { pgTable, text, timestamp, uuid, integer } from 'drizzle-orm/pg-core';
import { users } from './users';
import { channels } from './channels';

export const contexts = pgTable('contexts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  channelId: uuid('channel_id')
    .notNull()
    .references(() => channels.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  lastUserInteractionAt: timestamp('last_user_interaction_at').notNull().defaultNow(),
  turnCount: integer('turn_count').notNull().default(0),
  closedAt: timestamp('closed_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type Context = typeof contexts.$inferSelect;
export type NewContext = typeof contexts.$inferInsert;
