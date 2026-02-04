import type { ToolDef } from '@clifford/sdk';
import { z } from 'zod';

export const systemTool: ToolDef = {
  name: 'system',
  shortDescription: 'System diagnostics and health checks',
  longDescription:
    'System-level commands used to verify runtime availability and basic health signals.',
  pinned: true,
  commands: [
    {
      name: 'ping',
      shortDescription: 'Check liveness and timestamp',
      longDescription: 'Responds with a pong and current timestamp to confirm runtime availability.',
      usageExample: '{"name":"system.ping","args":{}}',
      argsSchema: z.object({}),
      classification: 'READ',
      handler: async () => {
        return {
          ok: true,
          ts: new Date().toISOString(),
        };
      },
    },
  ],
};
