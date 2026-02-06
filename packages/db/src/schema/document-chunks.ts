import { pgTable, text, timestamp, uuid, jsonb, index, customType } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { agents } from './agents';
import { users } from './users';

// Custom vector type for pgvector
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return 'vector(1536)';
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: string): number[] {
    // Parse [1,2,3,...] format
    return JSON.parse(value.replace(/^\[/, '[').replace(/\]$/, ']'));
  },
});

export const documentChunks = pgTable(
  'document_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    sourceType: text('source_type').notNull(), // file, url, memory, conversation
    sourceId: text('source_id'), // original file path, URL, or reference ID
    content: text('content').notNull(),
    embedding: vector('embedding'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_document_chunks_tenant').on(table.tenantId),
    index('idx_document_chunks_agent').on(table.agentId),
    index('idx_document_chunks_user').on(table.userId),
    // Note: HNSW index is created in migration, not here (Drizzle limitation)
  ]
);

export type DocumentChunk = typeof documentChunks.$inferSelect;
export type NewDocumentChunk = typeof documentChunks.$inferInsert;
