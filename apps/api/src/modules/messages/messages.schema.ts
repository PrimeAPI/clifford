import { z } from 'zod';

export const sendMessageSchema = z.object({
  channelId: z.string(),
  content: z.string().min(1),
  contextId: z.string().uuid().optional(),
});
