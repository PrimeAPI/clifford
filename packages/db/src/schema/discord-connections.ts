import { pgTable, text, timestamp, uuid, unique } from 'drizzle-orm/pg-core';
import { users } from './users';

export const discordConnections = pgTable(
  'discord_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    discordUserId: text('discord_user_id').notNull(),
    discordUsername: text('discord_username').notNull(),
    discordAvatar: text('discord_avatar'),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    expiresAt: timestamp('expires_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    userDiscordUnique: unique().on(table.userId, table.discordUserId),
  })
);

export type DiscordConnection = typeof discordConnections.$inferSelect;
export type NewDiscordConnection = typeof discordConnections.$inferInsert;
