import { z } from 'zod';

// Tool Call Command
export const toolCallSchema = z.object({
  type: z.literal('tool_call'),
  name: z.string().describe('Tool command name in format tool.command'),
  args: z.record(z.unknown()).optional().describe('Arguments to pass to the tool'),
});

// Send Message Command
export const sendMessageSchema = z.object({
  type: z.literal('send_message'),
  message: z.string().describe('Message content to send to the user'),
});

// Set Output Command
export const setOutputSchema = z.object({
  type: z.literal('set_output'),
  output: z.string().describe('Output content'),
  mode: z.enum(['replace', 'append']).optional().describe('How to update output'),
});

// Finish Command
export const finishSchema = z.object({
  type: z.literal('finish'),
  output: z.string().optional().describe('Final output content'),
  mode: z.enum(['replace', 'append']).optional().describe('How to update output'),
});

// Decision Command
export const decisionSchema = z.object({
  type: z.literal('decision'),
  content: z.string().describe('Decision content'),
  importance: z.enum(['low', 'normal', 'high']).optional().describe('Decision importance level'),
});

// Note Command
export const noteSchema = z.object({
  type: z.literal('note'),
  category: z
    .enum(['requirements', 'plan', 'artifact', 'validation'])
    .describe('Category of the note'),
  content: z.string().describe('Note content'),
});

// Set Run Limits Command
export const setRunLimitsSchema = z.object({
  type: z.literal('set_run_limits'),
  maxIterations: z.number().int().positive().describe('Maximum number of iterations'),
  reason: z.string().optional().describe('Reason for setting limits'),
});

// Recover Command
export const recoverSchema = z.object({
  type: z.literal('recover'),
  reason: z.string().describe('Reason for recovery'),
  action: z
    .enum(['retry', 'finish', 'ask_user'])
    .optional()
    .describe('Recovery action to take'),
  message: z.string().optional().describe('Optional message for recovery'),
});

// Subagent Specification
export const subagentSpecSchema = z.object({
  id: z.string().optional().describe('Optional subagent ID'),
  profile: z.string().optional().describe('Agent profile to use'),
  task: z.string().describe('Task description for the subagent'),
  tools: z.array(z.string()).optional().describe('Tools available to the subagent'),
  context: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string(),
      })
    )
    .optional()
    .describe('Context messages for the subagent'),
});

// Spawn Subagent Command
export const spawnSubagentSchema = z.object({
  type: z.literal('spawn_subagent'),
  subagent: subagentSpecSchema.describe('Subagent specification'),
});

// Spawn Multiple Subagents Command
export const spawnSubagentsSchema = z.object({
  type: z.literal('spawn_subagents'),
  subagents: z.array(subagentSpecSchema).describe('Array of subagent specifications'),
});

// Sleep Command
export const sleepSchema = z.object({
  type: z.literal('sleep'),
  reason: z.string().optional().describe('Reason for sleeping'),
  wakeAt: z.string().optional().describe('ISO-8601 timestamp to wake at'),
  delaySeconds: z.number().optional().describe('Seconds to sleep'),
  cron: z.string().optional().describe('Cron expression for periodic wake'),
});

// Combined RunCommand schema (discriminated union)
export const runCommandSchema = z.discriminatedUnion('type', [
  toolCallSchema,
  sendMessageSchema,
  setOutputSchema,
  finishSchema,
  decisionSchema,
  noteSchema,
  setRunLimitsSchema,
  recoverSchema,
]);

// Combined SpawnCommand schema (discriminated union)
export const spawnCommandSchema = z.discriminatedUnion('type', [
  spawnSubagentSchema,
  spawnSubagentsSchema,
  sleepSchema,
]);

// Combined schema for all commands
export const commandSchema = z.discriminatedUnion('type', [
  toolCallSchema,
  sendMessageSchema,
  setOutputSchema,
  finishSchema,
  decisionSchema,
  noteSchema,
  setRunLimitsSchema,
  recoverSchema,
  spawnSubagentSchema,
  spawnSubagentsSchema,
  sleepSchema,
]);

// Type exports derived from schemas
export type ToolCallCommand = z.infer<typeof toolCallSchema>;
export type SendMessageCommand = z.infer<typeof sendMessageSchema>;
export type SetOutputCommand = z.infer<typeof setOutputSchema>;
export type FinishCommand = z.infer<typeof finishSchema>;
export type DecisionCommand = z.infer<typeof decisionSchema>;
export type NoteCommand = z.infer<typeof noteSchema>;
export type SetRunLimitsCommand = z.infer<typeof setRunLimitsSchema>;
export type RecoverCommand = z.infer<typeof recoverSchema>;
export type SubagentSpec = z.infer<typeof subagentSpecSchema>;
export type SpawnSubagentCommand = z.infer<typeof spawnSubagentSchema>;
export type SpawnSubagentsCommand = z.infer<typeof spawnSubagentsSchema>;
export type SleepCommand = z.infer<typeof sleepSchema>;
export type RunCommand = z.infer<typeof runCommandSchema>;
export type SpawnCommand = z.infer<typeof spawnCommandSchema>;
export type Command = z.infer<typeof commandSchema>;

// JSON Schema for OpenAI Structured Outputs
// We generate this at build time rather than runtime to avoid zod-to-json-schema dependency
export const commandJsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  oneOf: [
    {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'tool_call' },
        name: { type: 'string', description: 'Tool command name in format tool.command' },
        args: {
          type: 'object',
          additionalProperties: true,
          description: 'Arguments to pass to the tool',
        },
      },
      required: ['type', 'name'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'send_message' },
        message: { type: 'string', description: 'Message content to send to the user' },
      },
      required: ['type', 'message'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'set_output' },
        output: { type: 'string', description: 'Output content' },
        mode: { type: 'string', enum: ['replace', 'append'], description: 'How to update output' },
      },
      required: ['type', 'output'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'finish' },
        output: { type: 'string', description: 'Final output content' },
        mode: { type: 'string', enum: ['replace', 'append'], description: 'How to update output' },
      },
      required: ['type'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'decision' },
        content: { type: 'string', description: 'Decision content' },
        importance: {
          type: 'string',
          enum: ['low', 'normal', 'high'],
          description: 'Decision importance level',
        },
      },
      required: ['type', 'content'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'note' },
        category: {
          type: 'string',
          enum: ['requirements', 'plan', 'artifact', 'validation'],
          description: 'Category of the note',
        },
        content: { type: 'string', description: 'Note content' },
      },
      required: ['type', 'category', 'content'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'set_run_limits' },
        maxIterations: {
          type: 'integer',
          minimum: 1,
          description: 'Maximum number of iterations',
        },
        reason: { type: 'string', description: 'Reason for setting limits' },
      },
      required: ['type', 'maxIterations'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'recover' },
        reason: { type: 'string', description: 'Reason for recovery' },
        action: {
          type: 'string',
          enum: ['retry', 'finish', 'ask_user'],
          description: 'Recovery action to take',
        },
        message: { type: 'string', description: 'Optional message for recovery' },
      },
      required: ['type', 'reason'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'spawn_subagent' },
        subagent: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Optional subagent ID' },
            profile: { type: 'string', description: 'Agent profile to use' },
            task: { type: 'string', description: 'Task description for the subagent' },
            tools: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tools available to the subagent',
            },
            context: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  role: { type: 'string', enum: ['user', 'assistant'] },
                  content: { type: 'string' },
                },
                required: ['role', 'content'],
                additionalProperties: false,
              },
              description: 'Context messages for the subagent',
            },
          },
          required: ['task'],
          additionalProperties: false,
        },
      },
      required: ['type', 'subagent'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'spawn_subagents' },
        subagents: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Optional subagent ID' },
              profile: { type: 'string', description: 'Agent profile to use' },
              task: { type: 'string', description: 'Task description for the subagent' },
              tools: {
                type: 'array',
                items: { type: 'string' },
                description: 'Tools available to the subagent',
              },
              context: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    role: { type: 'string', enum: ['user', 'assistant'] },
                    content: { type: 'string' },
                  },
                  required: ['role', 'content'],
                  additionalProperties: false,
                },
                description: 'Context messages for the subagent',
              },
            },
            required: ['task'],
            additionalProperties: false,
          },
          description: 'Array of subagent specifications',
        },
      },
      required: ['type', 'subagents'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'sleep' },
        reason: { type: 'string', description: 'Reason for sleeping' },
        wakeAt: { type: 'string', description: 'ISO-8601 timestamp to wake at' },
        delaySeconds: { type: 'number', description: 'Seconds to sleep' },
        cron: { type: 'string', description: 'Cron expression for periodic wake' },
      },
      required: ['type'],
      additionalProperties: false,
    },
  ],
} as const;

// Parse function with validation
export function parseCommand(input: unknown): Command | null {
  const result = commandSchema.safeParse(input);
  if (result.success) {
    return result.data;
  }
  return null;
}

// Parse function that returns errors for logging
export function parseCommandWithErrors(input: unknown): {
  success: boolean;
  data?: Command;
  errors?: z.ZodError;
} {
  const result = commandSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, errors: result.error };
}
