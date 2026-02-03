import { pgTable, text, uuid, boolean, primaryKey } from 'drizzle-orm/pg-core';
import { agents } from './agents';

export const agentPlugins = pgTable(
  'agent_plugins',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    pluginName: text('plugin_name').notNull(),
    pluginVersion: text('plugin_version').notNull(),
    enabled: boolean('enabled').notNull().default(true),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.agentId, table.pluginName] }),
  })
);

export type AgentPlugin = typeof agentPlugins.$inferSelect;
export type NewAgentPlugin = typeof agentPlugins.$inferInsert;
