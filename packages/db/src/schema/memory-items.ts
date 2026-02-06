import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  boolean,
  doublePrecision,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { contexts } from './contexts';

export const memoryItems = pgTable('memory_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  level: integer('level').notNull(),
  module: text('module').notNull(),
  key: text('key').notNull(),
  value: text('value').notNull(),
  confidence: doublePrecision('confidence').notNull().default(0.5),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at').notNull().defaultNow(),
  contextId: uuid('context_id').references(() => contexts.id, { onDelete: 'set null' }),
  pinned: boolean('pinned').notNull().default(false),
  archived: boolean('archived').notNull().default(false),
});

export type MemoryItem = typeof memoryItems.$inferSelect;
export type NewMemoryItem = typeof memoryItems.$inferInsert;
