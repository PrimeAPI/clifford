import { pgTable, text, timestamp, uuid, jsonb, integer, boolean, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { agents } from './agents';

export const policyRules = pgTable(
  'policy_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    priority: integer('priority').default(0),
    // Conditions: { tool?: string, command?: string, classification?: string, argsPattern?: object }
    conditions: jsonb('conditions').notNull(),
    // Action: 'allow' | 'confirm' | 'deny' | 'rate_limit'
    action: text('action').notNull(),
    // Config: { quota?: number, ratePerHour?: number, approvalWorkflow?: string, message?: string }
    config: jsonb('config'),
    enabled: boolean('enabled').default(true),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_policy_rules_tenant').on(table.tenantId),
    index('idx_policy_rules_agent').on(table.agentId),
    index('idx_policy_rules_priority').on(table.tenantId, table.priority),
  ]
);

export type PolicyRule = typeof policyRules.$inferSelect;
export type NewPolicyRule = typeof policyRules.$inferInsert;

// Type definitions for the JSONB fields
export interface PolicyConditions {
  tool?: string; // Tool name pattern (supports wildcards: 'memory.*')
  command?: string; // Full command pattern (e.g., 'memory.put')
  classification?: 'READ' | 'WRITE' | 'DESTRUCT' | 'SENSITIVE';
  argsPattern?: Record<string, unknown>; // Match specific argument values
  runKind?: string; // Match run kind (e.g., 'coordinator', 'subagent')
}

export interface PolicyConfig {
  quota?: number; // Max calls allowed
  ratePerHour?: number; // Rate limit per hour
  approvalWorkflow?: string; // Workflow ID for approval
  message?: string; // Custom message for denials
  requireReason?: boolean; // Require reason for confirmation
}

export type PolicyAction = 'allow' | 'confirm' | 'deny' | 'rate_limit';
