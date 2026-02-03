import { z } from 'zod';

// Job Payloads for BullMQ

export const RunJobSchema = z.object({
  type: z.literal('run'),
  runId: z.string(),
  tenantId: z.string(),
  agentId: z.string(),
});

export type RunJob = z.infer<typeof RunJobSchema>;

export const WakeJobSchema = z.object({
  type: z.literal('wake'),
  triggerId: z.string(),
  tenantId: z.string(),
  agentId: z.string(),
});

export type WakeJob = z.infer<typeof WakeJobSchema>;

export const DiscordEventJobSchema = z.object({
  type: z.literal('discord_event'),
  eventId: z.string(),
  tenantId: z.string(),
  channelId: z.string(),
  messageId: z.string(),
  content: z.string(),
});

export type DiscordEventJob = z.infer<typeof DiscordEventJobSchema>;

export type Job = RunJob | WakeJob | DiscordEventJob;
