import type { ToolContext, ToolDef } from '@clifford/sdk';
import { z } from 'zod';
import { documentChunks, getDb } from '@clifford/db';
import { eq, and, sql } from 'drizzle-orm';
import { generateEmbedding, chunkText } from '@clifford/core';

const retrievalSearchArgs = z.object({
  query: z.string().min(1).describe('Search query for semantic similarity'),
  limit: z.number().int().min(1).max(50).optional().describe('Max results to return'),
  scope: z
    .enum(['tenant', 'agent', 'user'])
    .optional()
    .describe('Scope of search: tenant (all), agent (agent-specific), user (user-specific)'),
});

const retrievalIndexArgs = z.object({
  content: z.string().min(1).describe('Content to index'),
  sourceType: z
    .enum(['file', 'url', 'memory', 'conversation', 'manual'])
    .describe('Type of content source'),
  sourceId: z.string().optional().describe('Original source identifier (path, URL, etc.)'),
  metadata: z.record(z.unknown()).optional().describe('Additional metadata'),
});

const retrievalDeleteArgs = z.object({
  sourceId: z.string().describe('Source ID to delete chunks for'),
});

export const retrievalTool: ToolDef = {
  name: 'retrieval',
  shortDescription: 'Semantic search and document indexing for RAG',
  longDescription:
    'Search indexed documents using semantic similarity, or index new documents for later retrieval. Uses vector embeddings for accurate semantic matching.',
  config: {
    fields: [
      {
        key: 'openai_api_key',
        label: 'OpenAI API Key',
        description: 'API key for generating embeddings (uses text-embedding-3-small)',
        type: 'secret',
        required: true,
      },
      {
        key: 'chunk_size',
        label: 'Chunk Size',
        description: 'Maximum characters per chunk when indexing (default: 512)',
        type: 'number',
        min: 100,
        max: 2000,
      },
      {
        key: 'chunk_overlap',
        label: 'Chunk Overlap',
        description: 'Character overlap between chunks (default: 50)',
        type: 'number',
        min: 0,
        max: 200,
      },
    ],
    schema: z.object({
      openai_api_key: z.string().min(1),
      chunk_size: z.number().int().min(100).max(2000).optional(),
      chunk_overlap: z.number().int().min(0).max(200).optional(),
    }),
  },
  commands: [
    {
      name: 'search',
      shortDescription: 'Search indexed documents',
      longDescription:
        'Performs semantic similarity search across indexed documents. Returns the most relevant chunks based on vector similarity.',
      usageExample:
        '{"name":"retrieval.search","args":{"query":"authentication flow","limit":10,"scope":"agent"}}',
      argsSchema: retrievalSearchArgs,
      classification: 'READ',
      handler: async (ctx: ToolContext, args: unknown) => {
        const { query, limit = 10, scope = 'agent' } = retrievalSearchArgs.parse(args);
        const config = (ctx.toolConfig ?? {}) as {
          openai_api_key?: string;
        };

        if (!config.openai_api_key) {
          return { success: false, error: 'not_configured', message: 'OpenAI API key required' };
        }

        const db = ctx.db as ReturnType<typeof getDb>;

        try {
          // Generate embedding for the query
          const { embedding } = await generateEmbedding(query, {
            apiKey: config.openai_api_key,
          });

          const embeddingStr = `[${embedding.join(',')}]`;

          // Build WHERE clause based on scope
          let scopeCondition;
          if (scope === 'user' && ctx.userId) {
            scopeCondition = and(
              eq(documentChunks.tenantId, ctx.tenantId),
              eq(documentChunks.userId, ctx.userId)
            );
          } else if (scope === 'agent') {
            scopeCondition = and(
              eq(documentChunks.tenantId, ctx.tenantId),
              eq(documentChunks.agentId, ctx.agentId)
            );
          } else {
            // tenant scope - all documents for the tenant
            scopeCondition = eq(documentChunks.tenantId, ctx.tenantId);
          }

          // Perform vector similarity search using cosine distance
          const results = (await db.execute(sql`
            SELECT
              id,
              content,
              source_type,
              source_id,
              metadata,
              1 - (embedding <=> ${embeddingStr}::vector) as similarity
            FROM document_chunks
            WHERE ${scopeCondition}
              AND embedding IS NOT NULL
            ORDER BY embedding <=> ${embeddingStr}::vector
            LIMIT ${limit}
          `)) as unknown as {
            rows: Array<{
              id: string;
              content: string;
              source_type: string;
              source_id: string | null;
              metadata: unknown;
              similarity: number;
            }>;
          };

          return {
            success: true,
            query,
            scope,
            resultCount: results.rows.length,
            results: results.rows.map((row) => ({
              id: row.id,
              content: row.content,
              sourceType: row.source_type,
              sourceId: row.source_id,
              metadata: row.metadata,
              similarity: row.similarity,
            })),
          };
        } catch (err) {
          ctx.logger.error({ error: err }, 'Retrieval search failed');
          return { success: false, error: 'search_failed', message: String(err) };
        }
      },
    },
    {
      name: 'index',
      shortDescription: 'Index content for retrieval',
      longDescription:
        'Indexes content by splitting it into chunks and generating embeddings. The content will then be searchable via retrieval.search.',
      usageExample:
        '{"name":"retrieval.index","args":{"content":"...","sourceType":"file","sourceId":"/docs/api.md"}}',
      argsSchema: retrievalIndexArgs,
      classification: 'WRITE',
      handler: async (ctx: ToolContext, args: unknown) => {
        const { content, sourceType, sourceId, metadata } = retrievalIndexArgs.parse(args);
        const config = (ctx.toolConfig ?? {}) as {
          openai_api_key?: string;
          chunk_size?: number;
          chunk_overlap?: number;
        };

        if (!config.openai_api_key) {
          return { success: false, error: 'not_configured', message: 'OpenAI API key required' };
        }

        const db = ctx.db as ReturnType<typeof getDb>;
        const chunkSize = config.chunk_size ?? 512;
        const chunkOverlap = config.chunk_overlap ?? 50;

        try {
          // Split content into chunks
          const chunks = chunkText(content, chunkSize, chunkOverlap);

          if (chunks.length === 0) {
            return { success: false, error: 'no_content', message: 'No content to index' };
          }

          // Generate embeddings for all chunks in batch would be more efficient,
          // but for simplicity we'll do them one at a time
          const insertedIds: string[] = [];
          let totalTokens = 0;

          for (const chunk of chunks) {
            const { embedding, tokensUsed } = await generateEmbedding(chunk, {
              apiKey: config.openai_api_key,
            });
            totalTokens += tokensUsed;

            const [inserted] = await db
              .insert(documentChunks)
              .values({
                tenantId: ctx.tenantId,
                agentId: ctx.agentId,
                userId: ctx.userId ?? null,
                sourceType,
                sourceId: sourceId ?? null,
                content: chunk,
                embedding,
                metadata: metadata ?? null,
              })
              .returning({ id: documentChunks.id });

            if (inserted) {
              insertedIds.push(inserted.id);
            }
          }

          ctx.logger.info(
            { sourceType, sourceId, chunkCount: chunks.length, totalTokens },
            'Content indexed'
          );

          return {
            success: true,
            message: `Indexed ${chunks.length} chunks`,
            chunkCount: chunks.length,
            chunkIds: insertedIds,
            tokensUsed: totalTokens,
          };
        } catch (err) {
          ctx.logger.error({ error: err }, 'Retrieval index failed');
          return { success: false, error: 'index_failed', message: String(err) };
        }
      },
    },
    {
      name: 'delete',
      shortDescription: 'Delete indexed content',
      longDescription:
        'Deletes all indexed chunks for a specific source. Use this to remove outdated or incorrect content.',
      usageExample: '{"name":"retrieval.delete","args":{"sourceId":"/docs/api.md"}}',
      argsSchema: retrievalDeleteArgs,
      classification: 'DESTRUCT',
      handler: async (ctx: ToolContext, args: unknown) => {
        const { sourceId } = retrievalDeleteArgs.parse(args);
        const db = ctx.db as ReturnType<typeof getDb>;

        try {
          const result = await db
            .delete(documentChunks)
            .where(
              and(
                eq(documentChunks.tenantId, ctx.tenantId),
                eq(documentChunks.agentId, ctx.agentId),
                eq(documentChunks.sourceId, sourceId)
              )
            )
            .returning({ id: documentChunks.id });

          ctx.logger.info({ sourceId, deletedCount: result.length }, 'Content deleted');

          return {
            success: true,
            message: `Deleted ${result.length} chunks`,
            deletedCount: result.length,
          };
        } catch (err) {
          ctx.logger.error({ error: err }, 'Retrieval delete failed');
          return { success: false, error: 'delete_failed', message: String(err) };
        }
      },
    },
  ],
};
