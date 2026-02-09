import type { ToolDef } from '@clifford/sdk';
import { z } from 'zod';

export const systemTool: ToolDef = {
  name: 'system',
  shortDescription: 'System diagnostics and health checks',
  longDescription:
    'Provides system-level diagnostic commands to verify runtime availability, check system health, and confirm the tool execution pipeline is functioning. Use this to test connectivity or debug tool execution issues.',
  pinned: true,
  config: {
    fields: [
      {
        key: 'allow_ping',
        label: 'Allow Ping',
        description: 'If false, system.ping will return an error.',
        type: 'boolean',
      },
      {
        key: 'max_retries',
        label: 'Max Retries',
        description: 'Maximum retries when this tool fails.',
        type: 'number',
        min: 0,
        max: 5,
      },
      {
        key: 'expose_errors',
        label: 'Expose Errors',
        description: 'Include tool error details in user-facing messages.',
        type: 'boolean',
      },
    ],
    schema: z.object({
      allow_ping: z.boolean().optional(),
      max_retries: z.number().int().min(0).max(5).optional(),
      expose_errors: z.boolean().optional(),
    }),
  },
  commands: [
    {
      name: 'ping',
      shortDescription: 'Check liveness and timestamp',
      longDescription:
        'Responds with a pong and current timestamp to confirm runtime availability. Returns {ok: true, ts: "ISO-8601 timestamp"}. Use this to verify the tool execution system is working or measure round-trip latency. No arguments required.',
      usageExample: '{"name":"system.ping","args":{}}',
      argsSchema: z.object({}),
      classification: 'READ',
      handler: async (ctx) => {
        const config = (ctx.toolConfig ?? {}) as { allow_ping?: boolean };
        if (config.allow_ping === false) {
          return { ok: false, error: 'Ping disabled by configuration' };
        }
        return {
          ok: true,
          ts: new Date().toISOString(),
        };
      },
    },
  ],
};
