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

export const MessageJobSchema = z.object({
  type: z.literal('message'),
  messageId: z.string(),
});

export type MessageJob = z.infer<typeof MessageJobSchema>;

export const DeliveryJobSchema = z.object({
  type: z.literal('delivery'),
  provider: z.string(),
  messageId: z.string(),
  payload: z.record(z.unknown()),
});

export type DeliveryJob = z.infer<typeof DeliveryJobSchema>;

export const DeliveryAckJobSchema = z.object({
  type: z.literal('delivery_ack'),
  messageId: z.string(),
  status: z.enum(['delivered', 'failed']),
  error: z.string().optional(),
});

export type DeliveryAckJob = z.infer<typeof DeliveryAckJobSchema>;

export const MemoryWriteJobSchema = z.object({
  type: z.literal('memory_write'),
  contextId: z.string(),
  userId: z.string(),
  mode: z.enum(['close', 'compact']),
  segmentMessages: z
    .array(
      z.object({
        direction: z.enum(['inbound', 'outbound']),
        content: z.string(),
        createdAt: z.string().optional(),
      })
    )
    .optional(),
});

export type MemoryWriteJob = z.infer<typeof MemoryWriteJobSchema>;

export type Job =
  | RunJob
  | WakeJob
  | DiscordEventJob
  | MessageJob
  | DeliveryJob
  | DeliveryAckJob
  | MemoryWriteJob;
