import type { ToolDef, ToolContext } from '@clifford/sdk';
import { getDb, memoryKv } from '@clifford/db';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';

export const memoryPut: ToolDef = {
  name: 'memory.put',
  description: 'Store a key-value pair in agent memory',
  argsSchema: z.object({
    key: z.string(),
    value: z.string(),
  }),
  handler: async (ctx: ToolContext, args: unknown) => {
    const { key, value } = memoryPut.argsSchema.parse(args);
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
};
