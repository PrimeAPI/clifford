import { pgTable, text, timestamp, uuid, boolean, integer } from 'drizzle-orm/pg-core';
import { users } from './users';

export const userSettings = pgTable('user_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  theme: text('theme').notNull().default('system'), // light|dark|system
  notifications: boolean('notifications').notNull().default(true),
  llmProvider: text('llm_provider').notNull().default('openai'),
  llmModel: text('llm_model').notNull().default('gpt-4o-mini'),
  llmApiKeyEncrypted: text('llm_api_key_encrypted'),
  llmApiKeyIv: text('llm_api_key_iv'),
  llmApiKeyTag: text('llm_api_key_tag'),
  llmApiKeyLast4: text('llm_api_key_last4'),
  defaultSystemPrompt: text('default_system_prompt')
    .notNull()
    .default('You are Clifford, a very skilled and highly complex AI-Assistent!'),
  crossChannelContextEnabled: boolean('cross_channel_context_enabled').notNull().default(true),
  crossChannelContextLimit: integer('cross_channel_context_limit').notNull().default(12),
  memoryEnabled: boolean('memory_enabled').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type UserSettings = typeof userSettings.$inferSelect;
export type NewUserSettings = typeof userSettings.$inferInsert;
