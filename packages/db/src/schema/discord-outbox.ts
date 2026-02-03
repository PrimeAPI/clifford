import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

export const discordOutbox = pgTable('discord_outbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  discordUserId: text('discord_user_id').notNull(),
  content: text('content').notNull(),
  status: text('status').notNull().default('pending'), // pending|processing|sent|failed
  lastError: text('last_error'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type DiscordOutbox = typeof discordOutbox.$inferSelect;
export type NewDiscordOutbox = typeof discordOutbox.$inferInsert;
