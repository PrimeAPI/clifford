import { z } from 'zod';

export const discordEventSchema = z.object({
  discordUserId: z.string(),
  discordUsername: z.string(),
  discordAvatar: z.string().nullable().optional(),
  content: z.string(),
  channelId: z.string().optional(),
  messageId: z.string().optional(),
  attachments: z
    .array(
      z.object({
        fileName: z.string().min(1),
        mimeType: z.string().min(1).optional(),
        sizeBytes: z.number().int().min(0).optional(),
        dataBase64: z.string().min(1),
      })
    )
    .optional(),
});

export const connectDiscordSchema = z.object({
  code: z.string(),
});

export const discordContextQuerySchema = z.object({
  discordUserId: z.string(),
  discordUsername: z.string().optional(),
});

export const discordContextCreateSchema = z.object({
  discordUserId: z.string(),
  discordUsername: z.string().optional(),
  name: z.string().min(1).optional(),
});

export const discordContextActivateSchema = z.object({
  discordUserId: z.string(),
  discordUsername: z.string().optional(),
});
