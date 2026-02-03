import type { ToolDef } from '@clifford/sdk';
import { z } from 'zod';

const reminderSchema = z.object({
  name: z.string(),
  description: z.string(),
  dueAt: z.string().datetime(),
  repeats: z.boolean(),
  repeatRule: z.string().optional(),
  prompt: z.string(),
});

const reminderUpdatesSchema = reminderSchema.partial().omit({ name: true });

const remindersSetArgs = z.object({
  reminder: reminderSchema,
});

const remindersGetArgs = z.object({
  name: z.string().optional(),
});

const remindersUpdateArgs = z.object({
  name: z.string(),
  updates: reminderUpdatesSchema,
});

const remindersRemoveArgs = z.object({
  name: z.string(),
});

export const remindersTool: ToolDef = {
  name: 'reminders',
  shortDescription: 'Create and manage reminders',
  longDescription:
    'Set, read, update, and remove reminders that can later be backed by scheduler or cron tooling.',
  commands: [
    {
      name: 'set',
      shortDescription: 'Create a new reminder',
      longDescription: 'Registers a reminder with metadata including due time, repeat options, and prompt.',
      usageExample:
        '{"name":"reminders.set","args":{"reminder":{"name":"Weekly review","description":"Plan next week","dueAt":"2026-02-07T09:00:00Z","repeats":true,"repeatRule":"weekly","prompt":"Time for the weekly review."}}}',
      argsSchema: remindersSetArgs,
      classification: 'WRITE',
      handler: async (_ctx, args) => {
        const { reminder } = remindersSetArgs.parse(args);
        return {
          success: false,
          error: 'Not implemented yet',
          reminder,
        };
      },
    },
    {
      name: 'get',
      shortDescription: 'Fetch reminders',
      longDescription: 'Returns reminders, optionally filtered by reminder name.',
      usageExample: '{"name":"reminders.get","args":{"name":"Weekly review"}}',
      argsSchema: remindersGetArgs,
      classification: 'READ',
      handler: async (_ctx, args) => {
        const { name } = remindersGetArgs.parse(args);
        return {
          success: false,
          error: 'Not implemented yet',
          name,
          reminders: [],
        };
      },
    },
    {
      name: 'update',
      shortDescription: 'Update an existing reminder',
      longDescription: 'Updates reminder fields like due time, description, or prompt.',
      usageExample:
        '{"name":"reminders.update","args":{"name":"Weekly review","updates":{"dueAt":"2026-02-07T10:00:00Z"}}}',
      argsSchema: remindersUpdateArgs,
      classification: 'WRITE',
      handler: async (_ctx, args) => {
        const { name, updates } = remindersUpdateArgs.parse(args);
        return {
          success: false,
          error: 'Not implemented yet',
          name,
          updates,
        };
      },
    },
    {
      name: 'remove',
      shortDescription: 'Remove a reminder',
      longDescription: 'Deletes a reminder by name so it no longer triggers.',
      usageExample: '{"name":"reminders.remove","args":{"name":"Weekly review"}}',
      argsSchema: remindersRemoveArgs,
      classification: 'DESTRUCT',
      handler: async (_ctx, args) => {
        const { name } = remindersRemoveArgs.parse(args);
        return {
          success: false,
          error: 'Not implemented yet',
          name,
        };
      },
    },
  ],
};
