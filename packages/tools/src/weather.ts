import type { ToolDef } from '@clifford/sdk';
import { z } from 'zod';

const weatherGetArgs = z.object({
  region: z.string(),
  start: z.string().optional(),
  end: z.string().optional(),
});

export const weatherTool: ToolDef = {
  name: 'weather',
  shortDescription: 'Weather lookup by region and timeframe',
  longDescription:
    'Fetches weather information for a specific region and timeframe. Implementation will be added later.',
  commands: [
    {
      name: 'get',
      shortDescription: 'Retrieve weather data',
      longDescription: 'Returns weather for a region and timeframe defined by start and end dates.',
      usageExample:
        '{"name":"weather.get","args":{"region":"San Francisco, CA","start":"2026-02-03","end":"2026-02-05"}}',
      argsSchema: weatherGetArgs,
      classification: 'READ',
      handler: async (_ctx, args) => {
        const { region, start, end } = weatherGetArgs.parse(args);
        return {
          success: false,
          error: 'Not implemented yet',
          region,
          start,
          end,
        };
      },
    },
  ],
};
