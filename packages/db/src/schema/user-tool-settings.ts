import { pgTable, text, timestamp, uuid, boolean, jsonb, unique } from 'drizzle-orm/pg-core';
import { users } from './users';

export const userToolSettings = pgTable(
  'user_tool_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    toolName: text('tool_name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    pinned: boolean('pinned').notNull().default(false),
    important: boolean('important').notNull().default(false),
    config: jsonb('config').notNull().default({}),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    userToolUnique: unique().on(table.userId, table.toolName),
  })
);

export type UserToolSetting = typeof userToolSettings.$inferSelect;
export type NewUserToolSetting = typeof userToolSettings.$inferInsert;
