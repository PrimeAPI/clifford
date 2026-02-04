import type { ToolDef } from '@clifford/sdk';
import { getDb, memoryKv } from '@clifford/db';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';

const reminderSchema = z.object({
  name: z.string(),
  description: z.string(),
  dueAt: z.string().datetime(),
  repeats: z.boolean(),
  repeatRule: z.string().optional(),
  prompt: z.string(),
});

type Reminder = z.infer<typeof reminderSchema>;

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

async function loadReminderState(tenantId: string, agentId: string) {
  const db = getDb();
  const rows = await db
    .select()
    .from(memoryKv)
    .where(and(eq(memoryKv.tenantId, tenantId), eq(memoryKv.agentId, agentId), eq(memoryKv.key, 'reminders')))
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

async function saveReminderState(tenantId: string, agentId: string, reminders: Reminder[]) {
  const db = getDb();
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
  shortDescription: 'Create and manage reminders',
  longDescription:
    'Set, read, update, and remove reminders stored per tenant/agent. Uses in-memory storage backed by memory_kv.',
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
      },
    ],
    schema: z.object({
      default_timezone: z.string().optional(),
      max_reminders: z.number().int().min(1).max(1000).optional(),
    }),
  },
  commands: [
    {
      name: 'set',
      shortDescription: 'Create a new reminder',
      longDescription: 'Registers a reminder with metadata including due time, repeat options, and prompt.',
      usageExample:
        '{"name":"reminders.set","args":{"reminder":{"name":"Weekly review","description":"Plan next week","dueAt":"2026-02-07T09:00:00Z","repeats":true,"repeatRule":"weekly","prompt":"Time for the weekly review."}}}',
      argsSchema: remindersSetArgs,
      classification: 'WRITE',
      handler: async (ctx, args) => {
        const { reminder } = remindersSetArgs.parse(args);
        const config = (ctx.toolConfig ?? {}) as { max_reminders?: number };
        const list = await loadReminderState(ctx.tenantId, ctx.agentId);
        const maxReminders = config.max_reminders ?? 100;
        if (list.length >= maxReminders && !list.find((item) => item.name === reminder.name)) {
          return { success: false, error: 'Reminder limit reached', maxReminders };
        }
        const filtered = list.filter((item) => item.name !== reminder.name);
        filtered.push(reminder);
        await saveReminderState(ctx.tenantId, ctx.agentId, filtered);
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
        const list = await loadReminderState(ctx.tenantId, ctx.agentId);
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
        const list = await loadReminderState(ctx.tenantId, ctx.agentId);
        let updated: Reminder | null = null;
        const next = list.map((item) => {
          if (item.name !== name) return item;
          updated = { ...item, ...updates, name: item.name } as Reminder;
          return updated;
        });
        if (!updated) {
          return { success: false, error: 'Reminder not found' };
        }
        await saveReminderState(ctx.tenantId, ctx.agentId, next);
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
        const list = await loadReminderState(ctx.tenantId, ctx.agentId);
        const next = list.filter((item) => item.name !== name);
        if (next.length === list.length) {
          return { success: false, error: 'Reminder not found' };
        }
        await saveReminderState(ctx.tenantId, ctx.agentId, next);
        return { success: true, name };
      },
    },
  ],
};
