import { pgTable, text, timestamp, uuid, boolean } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  policyProfile: text('policy_profile').notNull().default('default'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
