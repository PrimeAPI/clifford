import { pgTable, text, timestamp, uuid, integer, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { agents } from './agents';
import { users } from './users';
import { sql } from 'drizzle-orm';

export const quotaUsage = pgTable(
  'quota_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    resourceType: text('resource_type').notNull(), // tokens, api_calls, tool_calls, embedding_tokens
    period: text('period').notNull(), // hourly, daily, monthly
    periodStart: timestamp('period_start').notNull(),
    usageCount: integer('usage_count').default(0),
    usageLimit: integer('usage_limit'), // NULL means no limit
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_quota_usage_tenant').on(table.tenantId),
    index('idx_quota_usage_agent').on(table.agentId),
    index('idx_quota_usage_period').on(
      table.tenantId,
      table.resourceType,
      table.period,
      table.periodStart
    ),
  ]
);

export type QuotaUsage = typeof quotaUsage.$inferSelect;
export type NewQuotaUsage = typeof quotaUsage.$inferInsert;

export type ResourceType = 'tokens' | 'api_calls' | 'tool_calls' | 'embedding_tokens';
export type QuotaPeriod = 'hourly' | 'daily' | 'monthly';

/**
 * Get the start of the current period for a given period type.
 */
export function getPeriodStart(period: QuotaPeriod, now: Date = new Date()): Date {
  const result = new Date(now);
  result.setMilliseconds(0);
  result.setSeconds(0);
  result.setMinutes(0);

  switch (period) {
    case 'hourly':
      // Already at the start of the hour
      break;
    case 'daily':
      result.setHours(0);
      break;
    case 'monthly':
      result.setHours(0);
      result.setDate(1);
      break;
  }

  return result;
}
