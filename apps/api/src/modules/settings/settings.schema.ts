import { z } from 'zod';

export const llmSettingsSchema = z.object({
  provider: z.enum(['openai']).optional(),
  model: z.string().min(1).optional(),
  fallbackModel: z.string().min(1).optional().nullable(),
  apiKey: z.string().optional().nullable(),
});

export const systemPromptSchema = z.object({
  defaultSystemPrompt: z.string().min(1).nullable(),
});

export const crossChannelSchema = z.object({
  enabled: z.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export const memorySchema = z.object({
  enabled: z.boolean().optional(),
});
