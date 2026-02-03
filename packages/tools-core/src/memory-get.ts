import type { ToolDef, ToolContext } from '@clifford/sdk';
import { getDb, memoryKv } from '@clifford/db';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';

export const memoryGet: ToolDef = {
  name: 'memory.get',
  description: 'Retrieve a value from agent memory by key',
  argsSchema: z.object({
    key: z.string(),
  }),
  handler: async (ctx: ToolContext, args: unknown) => {
    const { key } = memoryGet.argsSchema.parse(args);
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
};
