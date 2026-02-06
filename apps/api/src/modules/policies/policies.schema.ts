import { z } from 'zod';

export const policyConditionsSchema = z.object({
  tool: z.string().optional(),
  command: z.string().optional(),
  classification: z.enum(['READ', 'WRITE', 'DESTRUCT', 'SENSITIVE']).optional(),
  argsPattern: z.record(z.unknown()).optional(),
});

export const policyConfigSchema = z.object({
  quota: z.number().int().positive().optional(),
  ratePerHour: z.number().int().positive().optional(),
  approvalWorkflow: z.string().optional(),
  message: z.string().optional(),
  requireReason: z.boolean().optional(),
});

export const createPolicySchema = z.object({
  agentId: z.string().uuid().optional(),
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  priority: z.number().int().min(-100).max(100).optional(),
  conditions: policyConditionsSchema,
  action: z.enum(['allow', 'confirm', 'deny', 'rate_limit']),
  config: policyConfigSchema.optional(),
  enabled: z.boolean().optional(),
});

export const updatePolicySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().optional(),
  priority: z.number().int().min(-100).max(100).optional(),
  conditions: policyConditionsSchema.optional(),
  action: z.enum(['allow', 'confirm', 'deny', 'rate_limit']).optional(),
  config: policyConfigSchema.optional(),
  enabled: z.boolean().optional(),
});

export const listPoliciesQuerySchema = z.object({
  agentId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const listQuotasQuerySchema = z.object({
  agentId: z.string().uuid().optional(),
  resourceType: z.enum(['tokens', 'api_calls', 'tool_calls', 'embedding_tokens']).optional(),
  period: z.enum(['hourly', 'daily', 'monthly']).optional(),
});
