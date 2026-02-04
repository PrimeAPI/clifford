import type { ToolDef, ToolResolver } from '@clifford/sdk';
import { z } from 'zod';
import { describeToolDetails, describeToolBrief } from '@clifford/sdk';

const listArgs = z.object({});
const describeArgs = z.object({
  name: z.string().min(1),
});

function requireResolver(resolver?: ToolResolver) {
  if (!resolver) {
    throw new Error('Tool resolver not available');
  }
  return resolver;
}

export const toolsTool: ToolDef = {
  name: 'tools',
  shortDescription: 'Tool discovery and descriptions',
  longDescription: 'List available tools and fetch detailed descriptions for a specific tool.',
  pinned: true,
  config: {
    fields: [
      {
        key: 'list_limit',
        label: 'List Limit',
        description: 'Maximum number of tools returned by tools.list.',
        type: 'number',
        min: 1,
        max: 100,
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
      list_limit: z.number().int().min(1).max(100).optional(),
      max_retries: z.number().int().min(0).max(5).optional(),
      expose_errors: z.boolean().optional(),
    }),
  },
  commands: [
    {
      name: 'list',
      shortDescription: 'List tools with short descriptions',
      longDescription: 'Returns all available tools and their short descriptions.',
      usageExample: '{"name":"tools.list","args":{}}',
      argsSchema: listArgs,
      classification: 'READ',
      handler: async (ctx) => {
        const resolver = requireResolver(ctx.toolResolver);
        const config = (ctx.toolConfig ?? {}) as { list_limit?: number };
        const tools = resolver.listTools().map((tool) => ({
          name: tool.name,
          shortDescription: tool.shortDescription,
          brief: describeToolBrief(tool),
          commands: tool.commands.map((command) => `${tool.name}.${command.name}`),
        }));
        const limit = config.list_limit ?? tools.length;
        const limited = tools.slice(0, limit);
        return { success: true, tools: limited };
      },
    },
    {
      name: 'describe',
      shortDescription: 'Get detailed tool description',
      longDescription:
        'Returns the long description and command details for a specified tool name.',
      usageExample: '{"name":"tools.describe","args":{"name":"memory"}}',
      argsSchema: describeArgs,
      classification: 'READ',
      handler: async (ctx, args) => {
        const { name } = describeArgs.parse(args);
        const resolver = requireResolver(ctx.toolResolver);
        const tool = resolver.getTool(name);
        if (!tool) {
          return { success: false, error: 'Tool not found' };
        }
        return { success: true, detail: describeToolDetails(tool) };
      },
    },
  ],
};
