import type { ToolDef, ToolContext } from '@clifford/sdk';
import { getDb, memoryKv, memoryItems, contexts, messages } from '@clifford/db';
import { z } from 'zod';
import { eq, and, desc, sql } from 'drizzle-orm';

const memoryGetArgs = z.object({
  key: z.string().min(1).max(255).describe('Memory key to retrieve. Max 255 characters.'),
});

const memoryPutArgs = z.object({
  key: z
    .string()
    .min(1)
    .max(255)
    .describe('Memory key to store. Max 255 characters. Use descriptive keys like "user_timezone" or "project_name".'),
  value: z
    .string()
    .max(10000)
    .describe('Value to store. Max 10,000 characters. Can be any string data including JSON.'),
});

const memorySearchArgs = z.object({
  query: z
    .string()
    .min(1)
    .max(200)
    .describe('Search query string. Searches across module, key, and value fields. Max 200 characters.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('Maximum number of results to return. Range: 1-50. Default: 20.'),
  includeActive: z
    .boolean()
    .optional()
    .describe('Include memories already in active context (top 5 per level). Default: false.'),
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
  icon: 'brain',
  shortDescription: 'Agent memory storage and retrieval',
  longDescription:
    'Persistent key-value memory storage for the agent. Use memory.get/put for agent-specific data like user preferences or context. Use memory.search to find relevant user memories across conversations. Use memory.sessions to browse past conversation sessions and memory.session_messages to retrieve specific conversation history. Memory persists across runs and is scoped to tenant/agent.',
  pinned: true,
  config: {
    fields: [
      {
        key: 'search_limit',
        label: 'Search Limit',
        description: 'Default number of memory items returned by search.',
        type: 'number',
        min: 1,
        max: 50,
        defaultValue: 20,
      },
      {
        key: 'include_active_default',
        label: 'Include Active Memories',
        description: 'Include memories already in the active context window by default.',
        type: 'boolean',
        defaultValue: false,
      },
      {
        key: 'session_limit',
        label: 'Session List Limit',
        description: 'Default number of sessions returned.',
        type: 'number',
        min: 1,
        max: 50,
        defaultValue: 20,
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
      search_limit: z.number().int().min(1).max(50).optional(),
      include_active_default: z.boolean().optional(),
      session_limit: z.number().int().min(1).max(50).optional(),
      max_retries: z.number().int().min(0).max(5).optional(),
      expose_errors: z.boolean().optional(),
    }),
  },
  completeRequirement:
    'If memory updates are needed, they have been reasoned through and completed if necessary.',
  commands: [
    {
      name: 'get',
      shortDescription: 'Retrieve a stored memory value',
      longDescription:
        'Looks up a memory entry by key for the current tenant and agent context. Returns {success: true, key, value} if found, or {success: false, error: "Key not found"} if missing. Keys are case-sensitive. Use for retrieving user preferences, configuration, or contextual data stored by the agent.',
      usageExample: '{"name":"memory.get","args":{"key":"user_timezone"}}',
      argsSchema: memoryGetArgs,
      classification: 'READ',
      handler: async (ctx: ToolContext, args: unknown) => {
        const { key } = memoryGetArgs.parse(args);
        const db = ctx.db as ReturnType<typeof getDb>;

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
      longDescription:
        'Upserts a key-value pair for the current tenant and agent context. Creates a new entry if the key does not exist, or updates the existing value if it does. Use this to persist user preferences, context across conversations, or agent state. Returns {success: true, key}. Keys are case-sensitive and should be descriptive (e.g., "user_timezone", "last_search_query").',
      usageExample: '{"name":"memory.put","args":{"key":"user_timezone","value":"America/New_York"}}',
      argsSchema: memoryPutArgs,
      classification: 'WRITE',
      handler: async (ctx: ToolContext, args: unknown) => {
        const { key, value } = memoryPutArgs.parse(args);
        const db = ctx.db as ReturnType<typeof getDb>;

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
        'Searches user memory items (not archived) by keyword across module, key, and value fields using case-insensitive pattern matching. By default excludes memories currently in the active context window (top 5 per level) to avoid redundancy. Returns matching memories with metadata: id, level, module, key, value, confidence, lastSeenAt. Use includeActive:true to search ALL memories. Limit range: 1-50 (default: 20). Useful for finding relevant context from past conversations.',
      usageExample:
        '{"name":"memory.search","args":{"query":"vacation","limit":10,"includeActive":false}}',
      argsSchema: memorySearchArgs,
      classification: 'READ',
      handler: async (ctx: ToolContext, args: unknown) => {
        const { query, limit, includeActive } = memorySearchArgs.parse(args);
        if (!ctx.userId) {
          return { success: false, error: 'User context unavailable' };
        }
        const config = (ctx.toolConfig ?? {}) as {
          search_limit?: number;
          include_active_default?: boolean;
        };
        const db = ctx.db as ReturnType<typeof getDb>;
        const pattern = `%${query}%`;
        const match = sql<boolean>`(${memoryItems.value} ILIKE ${pattern} OR ${memoryItems.key} ILIKE ${pattern} OR ${memoryItems.module} ILIKE ${pattern})`;

        const items = await db
          .select()
          .from(memoryItems)
          .where(and(eq(memoryItems.userId, ctx.userId), eq(memoryItems.archived, false), match))
          .orderBy(desc(memoryItems.lastSeenAt))
          .limit(limit ?? config.search_limit ?? 20);

        const include = includeActive ?? config.include_active_default ?? false;
        const activeIds = include ? new Set<string>() : await loadActiveMemoryIds(db, ctx.userId);
        const results = items.filter((item) => include || !activeIds.has(item.id));

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
        const config = (ctx.toolConfig ?? {}) as { session_limit?: number };
        const db = ctx.db as ReturnType<typeof getDb>;
        const rows = await db
          .select()
          .from(contexts)
          .where(eq(contexts.userId, ctx.userId))
          .orderBy(desc(contexts.updatedAt))
          .limit(limit ?? config.session_limit ?? 10);

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
        const db = ctx.db as ReturnType<typeof getDb>;
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
