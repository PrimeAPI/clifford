import { z } from 'zod';

const routingModelSpecSchema = z.object({
  model: z.string().min(1),
  fallbackModel: z.string().min(1).nullable().optional(),
  instruction: z.string().max(300).optional(),
});

const routingConfigSchema = z.object({
  planner: routingModelSpecSchema,
  executor: routingModelSpecSchema,
  verifier: routingModelSpecSchema,
});

export const llmSettingsSchema = z.object({
  provider: z.enum(['openai']).optional(),
  model: z.string().min(1).optional(),
  fallbackModel: z.string().min(1).optional().nullable(),
  apiKey: z.string().optional().nullable(),
  autoSelectLowestCost: z.boolean().optional(),
  enabledModelIds: z.array(z.string().min(1)).optional(),
  routingDraft: routingConfigSchema.optional(),
  activateDraft: z.boolean().optional(),
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
