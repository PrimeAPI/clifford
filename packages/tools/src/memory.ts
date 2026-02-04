import type { ToolDef, ToolContext } from '@clifford/sdk';
import { getDb, memoryKv, memoryItems, contexts, messages } from '@clifford/db';
import { z } from 'zod';
import { eq, and, desc, sql } from 'drizzle-orm';

const memoryGetArgs = z.object({
  key: z.string(),
});

const memoryPutArgs = z.object({
  key: z.string(),
  value: z.string(),
});

const memorySearchArgs = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
  includeActive: z.boolean().optional(),
});

const memorySessionsArgs = z.object({
  limit: z.number().int().min(1).max(50).optional(),
});

const memorySessionMessagesArgs = z.object({
  contextId: z.string().uuid(),
  limit: z.number().int().min(1).max(200).optional(),
});

const MEMORY_PER_LEVEL_LIMIT = 5;

export const memoryTool: ToolDef = {
  name: 'memory',
  shortDescription: 'Agent memory storage and retrieval',
  longDescription:
    'Read/write key-value memory for the agent and search user memory items or past sessions.',
  pinned: true,
  completeRequirement:
    'If memory updates are needed, they have been reasoned through and completed if necessary.',
  commands: [
    {
      name: 'get',
      shortDescription: 'Retrieve a stored memory value',
      longDescription: 'Looks up a memory entry by key for the current tenant and agent context.',
      usageExample: '{"name":"memory.get","args":{"key":"project_name"}}',
      argsSchema: memoryGetArgs,
      classification: 'READ',
      handler: async (ctx: ToolContext, args: unknown) => {
        const { key } = memoryGetArgs.parse(args);
        const db = getDb();

        const result = await db
          .select()
          .from(memoryKv)
          .where(
            and(
              eq(memoryKv.tenantId, ctx.tenantId),
              eq(memoryKv.agentId, ctx.agentId),
              eq(memoryKv.key, key)
            )
          )
          .limit(1);

        if (result.length === 0) {
          return { success: false, error: 'Key not found' };
        }

        ctx.logger.info('Memory retrieved', { key });

        return {
          success: true,
          key,
          value: result[0]?.value,
        };
      },
    },
    {
      name: 'put',
      shortDescription: 'Store a memory value',
      longDescription: 'Upserts a key-value pair for the current tenant and agent context.',
      usageExample: '{"name":"memory.put","args":{"key":"project_name","value":"Clifford"}}',
      argsSchema: memoryPutArgs,
      classification: 'WRITE',
      handler: async (ctx: ToolContext, args: unknown) => {
        const { key, value } = memoryPutArgs.parse(args);
        const db = getDb();

        await db
          .insert(memoryKv)
          .values({
            tenantId: ctx.tenantId,
            agentId: ctx.agentId,
            key,
            value,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [memoryKv.tenantId, memoryKv.agentId, memoryKv.key],
            set: {
              value,
              updatedAt: new Date(),
            },
          });

        ctx.logger.info('Memory stored', { key });

        return { success: true, key };
      },
    },
    {
      name: 'search',
      shortDescription: 'Search user memories',
      longDescription:
        'Searches user memory items (not archived) by keyword across module, key, and value. By default excludes memories currently in the active context window (top 5 per level).',
      usageExample: '{"name":"memory.search","args":{"query":"bremen","limit":10}}',
      argsSchema: memorySearchArgs,
      classification: 'READ',
      handler: async (ctx: ToolContext, args: unknown) => {
        const { query, limit, includeActive } = memorySearchArgs.parse(args);
        if (!ctx.userId) {
          return { success: false, error: 'User context unavailable' };
        }
        const db = getDb();
        const pattern = `%${query}%`;
        const match = sql<boolean>`(${memoryItems.value} ILIKE ${pattern} OR ${memoryItems.key} ILIKE ${pattern} OR ${memoryItems.module} ILIKE ${pattern})`;

        const items = await db
          .select()
          .from(memoryItems)
          .where(and(eq(memoryItems.userId, ctx.userId), eq(memoryItems.archived, false), match))
          .orderBy(desc(memoryItems.lastSeenAt))
          .limit(limit ?? 20);

        const activeIds = includeActive ? new Set<string>() : await loadActiveMemoryIds(db, ctx.userId);
        const results = items.filter((item) => includeActive || !activeIds.has(item.id));

        return {
          success: true,
          total: results.length,
          memories: results.map((item) => ({
            id: item.id,
            level: item.level,
            module: item.module,
            key: item.key,
            value: item.value,
            confidence: item.confidence,
            lastSeenAt: item.lastSeenAt,
            inActiveSet: activeIds.has(item.id),
          })),
        };
      },
    },
    {
      name: 'sessions',
      shortDescription: 'List past sessions',
      longDescription: 'Returns recent contexts (sessions) for the current user.',
      usageExample: '{"name":"memory.sessions","args":{"limit":10}}',
      argsSchema: memorySessionsArgs,
      classification: 'READ',
      handler: async (ctx: ToolContext, args: unknown) => {
        const { limit } = memorySessionsArgs.parse(args);
        if (!ctx.userId) {
          return { success: false, error: 'User context unavailable' };
        }
        const db = getDb();
        const rows = await db
          .select()
          .from(contexts)
          .where(eq(contexts.userId, ctx.userId))
          .orderBy(desc(contexts.updatedAt))
          .limit(limit ?? 10);

        return {
          success: true,
          sessions: rows.map((row) => ({
            id: row.id,
            name: row.name,
            channelId: row.channelId,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            closedAt: row.closedAt,
            turnCount: row.turnCount,
          })),
        };
      },
    },
    {
      name: 'session_messages',
      shortDescription: 'Fetch messages from a past session',
      longDescription: 'Returns recent messages for a given context/session ID.',
      usageExample: '{"name":"memory.session_messages","args":{"contextId":"...","limit":50}}',
      argsSchema: memorySessionMessagesArgs,
      classification: 'READ',
      handler: async (ctx: ToolContext, args: unknown) => {
        const { contextId, limit } = memorySessionMessagesArgs.parse(args);
        if (!ctx.userId) {
          return { success: false, error: 'User context unavailable' };
        }
        const db = getDb();
        const rows = await db
          .select()
          .from(messages)
          .where(and(eq(messages.contextId, contextId), eq(messages.userId, ctx.userId)))
          .orderBy(desc(messages.createdAt))
          .limit(limit ?? 50);

        return {
          success: true,
          messages: rows.map((row) => ({
            id: row.id,
            direction: row.direction,
            content: row.content,
            createdAt: row.createdAt,
          })),
        };
      },
    },
  ],
};

async function loadActiveMemoryIds(db: ReturnType<typeof getDb>, userId: string) {
  const rows = await db
    .select()
    .from(memoryItems)
    .where(and(eq(memoryItems.userId, userId), eq(memoryItems.archived, false)));

  const byLevel = new Map<number, typeof rows>();
  for (const item of rows) {
    const list = byLevel.get(item.level) ?? [];
    list.push(item);
    byLevel.set(item.level, list);
  }

  for (const list of byLevel.values()) {
    list.sort((a, b) => (b.lastSeenAt?.getTime?.() ?? 0) - (a.lastSeenAt?.getTime?.() ?? 0));
  }

  const selected: typeof rows = [];
  for (const level of [0, 1, 2, 3, 4, 5]) {
    const list = byLevel.get(level) ?? [];
    selected.push(...list.slice(0, MEMORY_PER_LEVEL_LIMIT));
  }

  return new Set(selected.map((item) => item.id));
}
