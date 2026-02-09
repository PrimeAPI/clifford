import { z } from 'zod';

export const uploadFileSchema = z.object({
  channelId: z.string().uuid(),
  contextId: z.string().uuid().optional(),
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255).optional(),
  dataBase64: z.string().min(1),
});

export const listFilesQuerySchema = z.object({
  channelId: z.string().uuid().optional(),
  contextId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const updateFileSummarySchema = z.object({
  summary: z.string().min(1).max(4000),
});
