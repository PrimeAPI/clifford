import { z } from 'zod';

export const updateToolSchema = z.object({
  enabled: z.boolean().optional(),
  pinned: z.boolean().optional(),
  important: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
});
