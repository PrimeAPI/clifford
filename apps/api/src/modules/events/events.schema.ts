import { z } from 'zod';

export const discordEventSchema = z.object({
  channelId: z.string(),
  messageId: z.string(),
  content: z.string(),
});
