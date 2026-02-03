import type { Plugin, ToolDef } from '@clifford/sdk';
import { z } from 'zod';

const exampleHello: ToolDef = {
  name: 'example.hello',
  description: 'Greets a person by name',
  argsSchema: z.object({
    name: z.string(),
  }),
  handler: async (ctx, args) => {
    const { name } = exampleHello.argsSchema.parse(args);
    ctx.logger.info('Greeting user', { name });
    return {
      greeting: `Hello, ${name}! Welcome to Clifford.`,
    };
  },
};

const plugin: Plugin = {
  id: '@clifford/skill-example',
  version: '0.1.0',
  tools: [exampleHello],
};

export default plugin;
