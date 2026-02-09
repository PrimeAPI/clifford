import type { ToolDef } from '@clifford/sdk';
import { getDb, memoryKv } from '@clifford/db';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';

const reminderSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(200)
    .describe('Unique reminder name/identifier. Max 200 characters. Example: "Weekly standup"'),
  description: z
    .string()
    .max(1000)
    .describe('Reminder description. Max 1000 characters.'),
  dueAt: z
    .string()
    .datetime()
    .describe('Due date/time in ISO-8601 format (YYYY-MM-DDTHH:mm:ssZ). Example: "2026-02-14T09:00:00Z"'),
  repeats: z
    .boolean()
    .describe('Whether this reminder repeats after being triggered.'),
  repeatRule: z
    .string()
    .max(100)
    .optional()
    .describe('Repeat pattern if repeats=true. Examples: "daily", "weekly", "monthly", "yearly". Max 100 characters.'),
  prompt: z
    .string()
    .max(500)
    .describe('Message to display when reminder triggers. Max 500 characters.'),
});

type Reminder = z.infer<typeof reminderSchema>;

const reminderUpdatesSchema = reminderSchema.partial().omit({ name: true });

const remindersSetArgs = z.object({
  reminder: reminderSchema,
});

const remindersGetArgs = z.object({
  name: z
    .string()
    .max(200)
    .optional()
    .describe('Optional: Filter by specific reminder name. Returns all reminders if omitted.'),
});

const remindersUpdateArgs = z.object({
  name: z
    .string()
    .max(200)
    .describe('Name of the reminder to update. Max 200 characters.'),
  updates: reminderUpdatesSchema,
});

const remindersRemoveArgs = z.object({
  name: z
    .string()
    .max(200)
    .describe('Name of the reminder to remove. Max 200 characters.'),
});

async function loadReminderState(db: ReturnType<typeof getDb>, tenantId: string, agentId: string) {
  const rows = await db
    .select()
    .from(memoryKv)
    .where(
      and(
        eq(memoryKv.tenantId, tenantId),
        eq(memoryKv.agentId, agentId),
        eq(memoryKv.key, 'reminders')
      )
    )
    .limit(1);

  if (rows.length === 0) {
    return [] as Reminder[];
  }

  try {
    const parsed = JSON.parse(rows[0]?.value ?? '[]');
    if (Array.isArray(parsed)) {
      return parsed as Reminder[];
    }
  } catch {
    return [] as Reminder[];
  }

  return [] as Reminder[];
}

async function saveReminderState(db: ReturnType<typeof getDb>, tenantId: string, agentId: string, reminders: Reminder[]) {
  await db
    .insert(memoryKv)
    .values({
      tenantId,
      agentId,
      key: 'reminders',
      value: JSON.stringify(reminders),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [memoryKv.tenantId, memoryKv.agentId, memoryKv.key],
      set: {
        value: JSON.stringify(reminders),
        updatedAt: new Date(),
      },
    });
}

export const remindersTool: ToolDef = {
  name: 'reminders',
  icon: 'bell',
  shortDescription: 'Create and manage reminders',
  longDescription:
    'Create, read, update, and delete reminders with due dates and repeat rules. Reminders are stored per tenant/agent in the memory_kv table. Each reminder has a name (unique identifier), description, dueAt timestamp (ISO-8601), optional repeat configuration, and a prompt to display when triggered. Use for scheduling future actions, recurring tasks, or time-based notifications. Supports up to 1000 reminders per agent (configurable).',
  config: {
    fields: [
      {
        key: 'default_timezone',
        label: 'Default Timezone',
        description: 'Fallback timezone when dueAt is ambiguous.',
        type: 'string',
      },
      {
        key: 'max_reminders',
        label: 'Max Reminders',
        description: 'Maximum number of reminders allowed.',
        type: 'number',
        min: 1,
        max: 1000,
        defaultValue: 100,
      },
      {
        key: 'max_retries',
        label: 'Max Retries',
        description: 'Maximum retries when this tool fails.',
        type: 'number',
        min: 0,
        max: 5,
        defaultValue: 3,
      },
      {
        key: 'expose_errors',
        label: 'Expose Errors',
        description: 'Include tool error details in user-facing messages.',
        type: 'boolean',
        defaultValue: false,
      },
    ],
    schema: z.object({
      default_timezone: z.string().optional(),
      max_reminders: z.number().int().min(1).max(1000).optional(),
      max_retries: z.number().int().min(0).max(5).optional(),
      expose_errors: z.boolean().optional(),
    }),
  },
  commands: [
    {
      name: 'set',
      shortDescription: 'Create a new reminder',
      longDescription:
        'Registers a reminder with metadata including due time, repeat options, and prompt.',
      usageExample:
        '{"name":"reminders.set","args":{"reminder":{"name":"Weekly review","description":"Plan next week","dueAt":"2026-02-07T09:00:00Z","repeats":true,"repeatRule":"weekly","prompt":"Time for the weekly review."}}}',
      argsSchema: remindersSetArgs,
      classification: 'WRITE',
      handler: async (ctx, args) => {
        const { reminder } = remindersSetArgs.parse(args);
        const config = (ctx.toolConfig ?? {}) as { max_reminders?: number };
        const db = ctx.db as ReturnType<typeof getDb>;
        const list = await loadReminderState(db, ctx.tenantId, ctx.agentId);
        const maxReminders = config.max_reminders ?? 100;
        if (list.length >= maxReminders && !list.find((item) => item.name === reminder.name)) {
          return { success: false, error: 'Reminder limit reached', maxReminders };
        }
        const filtered = list.filter((item) => item.name !== reminder.name);
        filtered.push(reminder);
        await saveReminderState(db, ctx.tenantId, ctx.agentId, filtered);
        return { success: true, reminder };
      },
    },
    {
      name: 'get',
      shortDescription: 'Fetch reminders',
      longDescription: 'Returns reminders, optionally filtered by reminder name.',
      usageExample: '{"name":"reminders.get","args":{"name":"Weekly review"}}',
      argsSchema: remindersGetArgs,
      classification: 'READ',
      handler: async (ctx, args) => {
        const { name } = remindersGetArgs.parse(args);
        const db = ctx.db as ReturnType<typeof getDb>;
        const list = await loadReminderState(db, ctx.tenantId, ctx.agentId);
        const reminders = name ? list.filter((item) => item.name === name) : list;
        return { success: true, reminders };
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
      handler: async (ctx, args) => {
        const { name, updates } = remindersUpdateArgs.parse(args);
        const db = ctx.db as ReturnType<typeof getDb>;
        const list = await loadReminderState(db, ctx.tenantId, ctx.agentId);
        let updated: Reminder | null = null;
        const next = list.map((item) => {
          if (item.name !== name) return item;
          updated = { ...item, ...updates, name: item.name } as Reminder;
          return updated;
        });
        if (!updated) {
          return { success: false, error: 'Reminder not found' };
        }
        await saveReminderState(db, ctx.tenantId, ctx.agentId, next);
        return { success: true, reminder: updated };
      },
    },
    {
      name: 'remove',
      shortDescription: 'Remove a reminder',
      longDescription: 'Deletes a reminder by name so it no longer triggers.',
      usageExample: '{"name":"reminders.remove","args":{"name":"Weekly review"}}',
      argsSchema: remindersRemoveArgs,
      classification: 'DESTRUCT',
      handler: async (ctx, args) => {
        const { name } = remindersRemoveArgs.parse(args);
        const db = ctx.db as ReturnType<typeof getDb>;
        const list = await loadReminderState(db, ctx.tenantId, ctx.agentId);
        const next = list.filter((item) => item.name !== name);
        if (next.length === list.length) {
          return { success: false, error: 'Reminder not found' };
        }
        await saveReminderState(db, ctx.tenantId, ctx.agentId, next);
        return { success: true, name };
      },
    },
  ],
};
