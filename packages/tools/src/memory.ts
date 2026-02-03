import type { ToolDef, ToolContext } from '@clifford/sdk';
import { getDb, memoryKv } from '@clifford/db';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';

const memoryGetArgs = z.object({
  key: z.string(),
});

const memoryPutArgs = z.object({
  key: z.string(),
  value: z.string(),
});

export const memoryTool: ToolDef = {
  name: 'memory',
  shortDescription: 'Agent memory storage and retrieval',
  longDescription:
    'Read and write key-value pairs tied to a tenant and agent for lightweight recall between runs.',
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
  ],
};
