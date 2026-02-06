import { z } from 'zod';

export const createRunSchema = z.object({
  agentId: z.string().uuid(),
  channelId: z.string().uuid(),
  contextId: z.string().uuid().optional(),
  inputText: z.string().min(1),
});

export const listRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
