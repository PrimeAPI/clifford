import { z } from 'zod';

export const memoryCreateSchema = z.object({
  level: z.number().int().min(0).max(5),
  module: z.string().min(1),
  key: z.string().min(1),
  value: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  pinned: z.boolean().optional(),
});

export const memoryUpdateSchema = z.object({
  level: z.number().int().min(0).max(5).optional(),
  module: z.string().min(1).optional(),
  key: z.string().min(1).optional(),
  value: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  pinned: z.boolean().optional(),
});
