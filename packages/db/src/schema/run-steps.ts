import { pgTable, text, timestamp, uuid, integer, jsonb, unique } from 'drizzle-orm/pg-core';
import { runs } from './runs';

export const runSteps = pgTable(
  'run_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    type: text('type').notNull(), // message|tool_call|tool_result
    toolName: text('tool_name'),
    argsJson: jsonb('args_json'),
    resultJson: jsonb('result_json'),
    status: text('status').notNull().default('pending'), // pending|running|completed|failed
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    idempotencyUnique: unique().on(table.runId, table.idempotencyKey),
  })
);

export type RunStep = typeof runSteps.$inferSelect;
export type NewRunStep = typeof runSteps.$inferInsert;
