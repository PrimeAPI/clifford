import { z } from 'zod';

export const createChannelSchema = z.object({
  type: z.enum(['web', 'discord']),
  name: z.string().min(1),
  agentId: z.string().uuid().optional(),
  config: z.record(z.unknown()).optional(),
});

export const updateChannelSchema = z.object({
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  agentId: z.string().uuid().nullable().optional(),
  config: z.record(z.unknown()).optional(),
});
