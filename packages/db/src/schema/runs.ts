import { pgTable, text, timestamp, uuid, jsonb, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { agents } from './agents';
import { users } from './users';
import { channels } from './channels';
import { contexts } from './contexts';

export const runs = pgTable(
  'runs',
  {
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
    parentRunId: uuid('parent_run_id'),
    rootRunId: uuid('root_run_id'),
    kind: text('kind').notNull().default('coordinator'), // coordinator|subagent
    profile: text('profile'),
    inputText: text('input_text').notNull(),
    inputJson: jsonb('input_json'),
    outputText: text('output_text'),
    allowedTools: jsonb('allowed_tools'),
    wakeAt: timestamp('wake_at'),
    wakeReason: text('wake_reason'),
    status: text('status').notNull().default('pending'), // pending|running|waiting|completed|failed|cancelled
    // Cancellation fields
    cancelReason: text('cancel_reason'),
    cancelRequestedAt: timestamp('cancel_requested_at'),
    cancelRequestedBy: uuid('cancel_requested_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [index('idx_runs_status').on(table.status, table.updatedAt)]
);

export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
