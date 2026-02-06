import { z } from 'zod';

export const listContextsQuerySchema = z.object({
  channelId: z.string().uuid(),
});

export const createContextSchema = z.object({
  channelId: z.string().uuid(),
  name: z.string().min(1).optional(),
});
