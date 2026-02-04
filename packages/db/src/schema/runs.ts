import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { agents } from './agents';
import { users } from './users';
import { channels } from './channels';
import { contexts } from './contexts';

export const runs = pgTable('runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  channelId: uuid('channel_id').references(() => channels.id, { onDelete: 'set null' }),
  contextId: uuid('context_id').references(() => contexts.id, { onDelete: 'set null' }),
  inputText: text('input_text').notNull(),
  outputText: text('output_text'),
  status: text('status').notNull().default('pending'), // pending|running|completed|failed|cancelled
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
