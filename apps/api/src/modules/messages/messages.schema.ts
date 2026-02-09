import { z } from 'zod';

export const sendMessageSchema = z.object({
  channelId: z.string(),
  content: z.string().optional().default(''),
  contextId: z.string().uuid().optional(),
  fileIds: z.array(z.string().uuid()).optional().default([]),
})
  .refine((value) => value.content.trim().length > 0 || value.fileIds.length > 0, {
    message: 'Message must include text content or at least one file',
    path: ['content'],
  });
