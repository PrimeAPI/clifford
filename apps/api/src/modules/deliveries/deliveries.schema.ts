import { z } from 'zod';

export const ackSchema = z.object({
  messageId: z.string().uuid(),
  status: z.enum(['delivered', 'failed']),
  error: z.string().optional(),
});
