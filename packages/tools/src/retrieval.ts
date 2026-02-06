import type { ToolContext, ToolDef } from '@clifford/sdk';
import { z } from 'zod';

const retrievalSearchArgs = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(20).optional(),
});

export const retrievalTool: ToolDef = {
  name: 'retrieval',
  shortDescription: 'External retrieval/search for factual grounding',
  longDescription:
    'Searches an external retrieval endpoint for up-to-date or factual information. Requires tool config.',
  config: {
    fields: [
      {
        key: 'base_url',
        label: 'Base URL',
        description: 'Base URL for the retrieval API (e.g., https://retrieval.example.com).',
        type: 'string',
        required: true,
      },
      {
        key: 'api_key',
        label: 'API Key',
        description: 'Optional API key for the retrieval endpoint.',
        type: 'secret',
      },
      {
        key: 'default_limit',
        label: 'Default Limit',
        description: 'Default number of results to return.',
        type: 'number',
        min: 1,
        max: 20,
      },
    ],
    schema: z.object({
      base_url: z.string().min(1),
      api_key: z.string().optional(),
      default_limit: z.number().int().min(1).max(20).optional(),
    }),
  },
  commands: [
    {
      name: 'search',
      shortDescription: 'Search external sources',
      longDescription: 'Queries the configured retrieval endpoint for relevant sources.',
      usageExample: '{"name":"retrieval.search","args":{"query":"latest API pricing","limit":5}}',
      argsSchema: retrievalSearchArgs,
      classification: 'READ',
      handler: async (ctx: ToolContext, args: unknown) => {
        const { query, limit } = retrievalSearchArgs.parse(args);
        const config = (ctx.toolConfig ?? {}) as {
          base_url?: string;
          api_key?: string;
          default_limit?: number;
        };
        if (!config.base_url) {
          return { success: false, error: 'not_configured' };
        }
        const url = config.base_url.replace(/\/$/, '') + '/search';
        const payload = {
          query,
          limit: limit ?? config.default_limit ?? 5,
        };
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(config.api_key ? { Authorization: `Bearer ${config.api_key}` } : {}),
            },
            body: JSON.stringify(payload),
          });
          if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: `retrieval_error:${response.status}`, details: errorText };
          }
          const data = (await response.json()) as unknown;
          return { success: true, query, results: data };
        } catch (err) {
          return { success: false, error: 'retrieval_failed', details: String(err) };
        }
      },
    },
  ],
};
