import { z } from 'zod';

export const claimSchema = z.object({
  limit: z.number().int().min(1).max(50).optional(),
});

export const ackSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['sent', 'failed']),
  error: z.string().optional(),
});
