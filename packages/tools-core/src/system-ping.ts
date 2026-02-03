import type { ToolDef } from '@clifford/sdk';
import { z } from 'zod';

export const systemPing: ToolDef = {
  name: 'system.ping',
  description: 'Responds with a pong and current timestamp',
  argsSchema: z.object({}),
  handler: async () => {
    return {
      ok: true,
      ts: new Date().toISOString(),
    };
  },
};
