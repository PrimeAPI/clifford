import { pgTable, text, timestamp, uuid, primaryKey } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { agents } from './agents';

export const memoryKv = pgTable(
  'memory_kv',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: text('value').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.agentId, table.key] }),
  })
);

export type MemoryKv = typeof memoryKv.$inferSelect;
export type NewMemoryKv = typeof memoryKv.$inferInsert;
