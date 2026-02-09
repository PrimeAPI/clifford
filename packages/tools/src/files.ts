import type { ToolDef, ToolContext } from '@clifford/sdk';
import { getDb, userFiles } from '@clifford/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { randomUUID, createHash } from 'crypto';
import path from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';

const listArgs = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  channelId: z.string().uuid().optional(),
  contextId: z.string().uuid().optional(),
});

const searchArgs = z.object({
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(100).optional(),
});

const getArgs = z
  .object({
    fileId: z.string().uuid().optional(),
    id: z.string().uuid().optional(),
    fileName: z.string().min(1).max(255).optional(),
    name: z.string().min(1).max(255).optional(),
  })
  .refine((value) => Boolean(value.fileId || value.id || value.fileName || value.name), {
    message: 'fileId/id or fileName/name is required',
    path: ['fileId'],
  })
  .transform((value) => ({
    fileId: value.fileId ?? value.id ?? null,
    fileName: value.fileName ?? value.name ?? null,
  }));

const readTextArgs = z
  .object({
    fileId: z.string().uuid().optional(),
    id: z.string().uuid().optional(),
    maxChars: z.number().int().min(100).max(50000).optional(),
  })
  .refine((value) => Boolean(value.fileId || value.id), {
    message: 'fileId (or id) is required',
    path: ['fileId'],
  })
  .transform((value) => ({
    fileId: value.fileId ?? value.id!,
    maxChars: value.maxChars,
  }));

const updateSummaryArgs = z
  .object({
    fileId: z.string().uuid().optional(),
    id: z.string().uuid().optional(),
    summary: z.string().min(1).max(4000),
  })
  .refine((value) => Boolean(value.fileId || value.id), {
    message: 'fileId (or id) is required',
    path: ['fileId'],
  })
  .transform((value) => ({
    fileId: value.fileId ?? value.id!,
    summary: value.summary,
  }));

const createTextFileArgs = z.object({
  fileName: z.string().min(1).max(255).optional(),
  name: z.string().min(1).max(255).optional(),
  content: z.string().min(1).max(200000),
  channelId: z.string().uuid().optional(),
  contextId: z.string().uuid().optional(),
  summary: z.string().min(1).max(4000).optional(),
  mimeType: z.string().min(1).max(255).optional(),
})
  .refine((value) => Boolean(value.fileName || value.name), {
    message: 'fileName (or name) is required',
    path: ['fileName'],
  })
  .transform((value) => ({
    fileName: value.fileName ?? value.name!,
    content: value.content,
    channelId: value.channelId,
    contextId: value.contextId,
    summary: value.summary,
    mimeType: value.mimeType,
  }));

function requireUser(ctx: ToolContext) {
  if (!ctx.userId) {
    return { success: false, error: 'User context unavailable' } as const;
  }
  return null;
}

function toFileItem(file: typeof userFiles.$inferSelect) {
  return {
    id: file.id,
    channelId: file.channelId,
    contextId: file.contextId,
    fileName: file.fileName,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    summary: file.summary,
    hasExtractedText: Boolean(file.extractedText?.trim()),
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
  };
}

function sanitizeFileName(input: string) {
  const basename = path.basename(input).trim();
  const safe = basename.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, ' ');
  return safe || 'file.txt';
}

function sha256Hex(buffer: Buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

const TEXT_MIME_PREFIXES = ['text/'];
const TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/typescript',
  'application/x-yaml',
  'application/yaml',
  'application/csv',
]);
const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.xml',
  '.csv',
  '.tsv',
  '.yaml',
  '.yml',
  '.log',
  '.ini',
  '.toml',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.py',
  '.java',
  '.go',
  '.rs',
  '.sql',
  '.css',
  '.html',
  '.htm',
]);
const OFFICEPARSER_EXTENSIONS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.xls',
  '.xlsx',
  '.odt',
]);

type ExtractionStrategy = 'auto' | 'text_only' | 'officeparser_only';

type FilesToolConfig = {
  extraction_enabled?: boolean;
  extraction_strategy?: ExtractionStrategy;
  extraction_max_chars?: number;
  persist_extracted_text?: boolean;
  officeparser_timeout_ms?: number;
  allow_binary_fallback?: boolean;
};

function getFilesToolConfig(ctx: ToolContext): Required<FilesToolConfig> {
  const input = (ctx.toolConfig ?? {}) as FilesToolConfig;
  return {
    extraction_enabled: input.extraction_enabled ?? true,
    extraction_strategy: input.extraction_strategy ?? 'auto',
    extraction_max_chars: input.extraction_max_chars ?? 3000,
    persist_extracted_text: input.persist_extracted_text ?? true,
    officeparser_timeout_ms: input.officeparser_timeout_ms ?? 20000,
    allow_binary_fallback: input.allow_binary_fallback ?? false,
  };
}

function isLikelyTextFile(fileName: string, mimeType: string) {
  const ext = path.extname(fileName).toLowerCase();
  const normalizedMime = mimeType.toLowerCase();
  return (
    TEXT_MIME_PREFIXES.some((prefix) => normalizedMime.startsWith(prefix)) ||
    TEXT_MIME_TYPES.has(normalizedMime) ||
    TEXT_EXTENSIONS.has(ext)
  );
}

function shouldUseOfficeParser(fileName: string, mimeType: string, strategy: ExtractionStrategy) {
  if (strategy === 'text_only') return false;
  if (strategy === 'officeparser_only') return true;
  const ext = path.extname(fileName).toLowerCase();
  const normalizedMime = mimeType.toLowerCase();
  return (
    OFFICEPARSER_EXTENSIONS.has(ext) ||
    normalizedMime === 'application/pdf' ||
    normalizedMime.includes('word') ||
    normalizedMime.includes('excel') ||
    normalizedMime.includes('presentation')
  );
}

async function extractWithOfficeParser(filePath: string, timeoutMs: number): Promise<string> {
  const moduleName = 'officeparser';
  const officeParser = (await import(moduleName as string)) as any;
  const parser = officeParser?.default ?? officeParser;

  const parseByCallback = (target: any) =>
    new Promise<string>((resolve, reject) => {
      target(filePath, (err: unknown, data: unknown) => {
        if (err) return reject(err);
        resolve(typeof data === 'string' ? data : String(data ?? ''));
      });
    });

  let parsePromise: Promise<string> | null = null;
  if (typeof parser?.parseOfficeAsync === 'function') {
    parsePromise = parser.parseOfficeAsync(filePath);
  } else if (typeof parser?.parseOffice === 'function') {
    parsePromise = parseByCallback(parser.parseOffice);
  } else if (typeof parser?.extractText === 'function') {
    parsePromise = parser.extractText(filePath);
  } else {
    throw new Error('officeparser API not recognized');
  }

  if (!parsePromise) {
    throw new Error('officeparser promise not initialized');
  }

  return await withTimeout(parsePromise, timeoutMs, 'officeparser timed out');
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string) {
  let timeoutId: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function extractFileText(file: typeof userFiles.$inferSelect, config: Required<FilesToolConfig>) {
  if (!config.extraction_enabled) return { text: '', source: 'disabled' as const };

  const maxChars = Math.max(100, Math.min(200000, config.extraction_max_chars));
  const strategy = config.extraction_strategy;

  if (isLikelyTextFile(file.fileName, file.mimeType)) {
    const raw = (await readFile(file.storagePath)).toString('utf8').replace(/\0/g, '');
    return { text: raw.slice(0, maxChars), source: 'text' as const };
  }

  if (shouldUseOfficeParser(file.fileName, file.mimeType, strategy)) {
    try {
      const parsed = await extractWithOfficeParser(file.storagePath, config.officeparser_timeout_ms);
      const clean = parsed.replace(/\0/g, '').trim();
      if (clean) {
        return { text: clean.slice(0, maxChars), source: 'officeparser' as const };
      }
    } catch (error) {
      return {
        text: '',
        source: 'officeparser_error' as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (config.allow_binary_fallback) {
    const bytes = await readFile(file.storagePath);
    const asUtf8 = bytes.toString('utf8').replace(/\0/g, '').trim();
    if (asUtf8) {
      return { text: asUtf8.slice(0, maxChars), source: 'binary_fallback' as const };
    }
  }

  return { text: '', source: 'unsupported' as const };
}

export const filesTool: ToolDef = {
  name: 'files',
  icon: 'file-text',
  shortDescription: 'User file index, search, and metadata operations',
  longDescription:
    'Manage and query user-uploaded files. Use files.list and files.search to find files. Use files.get for details, files.read_text to retrieve indexed or parser-extracted text (including PDF/Office via officeparser), and files.update_summary to store a concise summary that improves retrieval quality.',
  config: {
    fields: [
      {
        key: 'extraction_enabled',
        label: 'Extraction Enabled',
        description: 'Allow files.read_text to parse files when no indexed text exists.',
        type: 'boolean',
        defaultValue: true,
      },
      {
        key: 'extraction_strategy',
        label: 'Extraction Strategy',
        description: 'Choose parser strategy for files.read_text.',
        type: 'select',
        options: ['auto', 'text_only', 'officeparser_only'],
        defaultValue: 'auto',
      },
      {
        key: 'extraction_max_chars',
        label: 'Max Extracted Chars',
        description: 'Maximum characters returned by files.read_text (default 3000).',
        type: 'number',
        min: 100,
        max: 200000,
        defaultValue: 3000,
      },
      {
        key: 'persist_extracted_text',
        label: 'Persist Extracted Text',
        description: 'Store newly extracted text back into DB for faster future reads.',
        type: 'boolean',
        defaultValue: true,
      },
      {
        key: 'officeparser_timeout_ms',
        label: 'Officeparser Timeout (ms)',
        description: 'Maximum parser runtime per file.',
        type: 'number',
        min: 1000,
        max: 120000,
        defaultValue: 20000,
      },
      {
        key: 'allow_binary_fallback',
        label: 'Allow Binary Fallback',
        description: 'Attempt UTF-8 fallback for unsupported binary files.',
        type: 'boolean',
        defaultValue: false,
      },
    ],
    schema: z.object({
      extraction_enabled: z.boolean().optional(),
      extraction_strategy: z.enum(['auto', 'text_only', 'officeparser_only']).optional(),
      extraction_max_chars: z.number().int().min(100).max(200000).optional(),
      persist_extracted_text: z.boolean().optional(),
      officeparser_timeout_ms: z.number().int().min(1000).max(120000).optional(),
      allow_binary_fallback: z.boolean().optional(),
    }),
  },
  commands: [
    {
      name: 'create_text',
      shortDescription: 'Create a text file for the current user',
      longDescription:
        'Creates and stores a UTF-8 text file in the user file index. Use this to generate reports, notes, or exports that can later be sent via send_message.fileIds.',
      usageExample:
        '{"name":"files.create_text","args":{"fileName":"summary.txt","content":"hello world"}}',
      argsSchema: createTextFileArgs,
      classification: 'WRITE',
      handler: async (ctx: ToolContext, args: unknown) => {
        const userCheck = requireUser(ctx);
        if (userCheck) return userCheck;

        const { fileName, content, channelId, contextId, summary, mimeType } =
          createTextFileArgs.parse(args);
        const db = ctx.db as ReturnType<typeof getDb>;
        const effectiveChannelId = channelId ?? ctx.channelId ?? null;

        const fileId = randomUUID();
        const safeName = sanitizeFileName(fileName);
        const userDir = path.resolve(process.env.FILE_STORAGE_DIR || '/tmp/clifford-uploads', ctx.userId!);
        await mkdir(userDir, { recursive: true });
        const storagePath = path.resolve(userDir, `${fileId}-${safeName}`);
        const bytes = Buffer.from(content, 'utf8');
        await writeFile(storagePath, bytes, { flag: 'wx' });

        const [file] = await db
          .insert(userFiles)
          .values({
            id: fileId,
            userId: ctx.userId!,
            channelId: effectiveChannelId,
            contextId: contextId ?? null,
            fileName: safeName,
            mimeType: mimeType ?? 'text/plain; charset=utf-8',
            sizeBytes: bytes.length,
            storagePath,
            sha256: sha256Hex(bytes),
            extractedText: content.slice(0, 30000),
            summary: summary ?? content.slice(0, 280),
          })
          .returning();

        if (!file) {
          return { success: false, error: 'Failed to create file' };
        }
        return { success: true, file: toFileItem(file) };
      },
    },
    {
      name: 'list',
      shortDescription: 'List user files',
      longDescription:
        'Returns recent files owned by the current user. Optional channelId/contextId filters narrow results to a specific conversation scope.',
      usageExample: '{"name":"files.list","args":{"limit":20}}',
      argsSchema: listArgs,
      classification: 'READ',
      handler: async (ctx: ToolContext, args: unknown) => {
        const userCheck = requireUser(ctx);
        if (userCheck) return userCheck;

        const { limit = 20, channelId, contextId } = listArgs.parse(args);
        const db = ctx.db as ReturnType<typeof getDb>;
        const filters = [eq(userFiles.userId, ctx.userId!)];
        if (channelId) filters.push(eq(userFiles.channelId, channelId));
        if (contextId) filters.push(eq(userFiles.contextId, contextId));

        const rows = await db
          .select()
          .from(userFiles)
          .where(and(...filters))
          .orderBy(desc(userFiles.createdAt))
          .limit(limit);

        return {
          success: true,
          total: rows.length,
          files: rows.map(toFileItem),
        };
      },
    },
    {
      name: 'search',
      shortDescription: 'Search files by name, summary, or extracted text',
      longDescription:
        'Runs a case-insensitive keyword search across file name, summary, and extracted text for the current user.',
      usageExample: '{"name":"files.search","args":{"query":"meeting notes","limit":10}}',
      argsSchema: searchArgs,
      classification: 'READ',
      handler: async (ctx: ToolContext, args: unknown) => {
        const userCheck = requireUser(ctx);
        if (userCheck) return userCheck;

        const { query, limit = 20 } = searchArgs.parse(args);
        const db = ctx.db as ReturnType<typeof getDb>;
        const pattern = `%${query}%`;
        const matchExpr = sql<boolean>`(
          ${userFiles.fileName} ILIKE ${pattern}
          OR COALESCE(${userFiles.summary}, '') ILIKE ${pattern}
          OR COALESCE(${userFiles.extractedText}, '') ILIKE ${pattern}
        )`;

        const rows = await db
          .select()
          .from(userFiles)
          .where(and(eq(userFiles.userId, ctx.userId!), matchExpr))
          .orderBy(desc(userFiles.updatedAt))
          .limit(limit);

        return {
          success: true,
          total: rows.length,
          files: rows.map(toFileItem),
        };
      },
    },
    {
      name: 'get',
      shortDescription: 'Get a file record by id',
      longDescription:
        'Returns metadata for a specific user file, including mime type, size, summary, and extracted-text availability.',
      usageExample: '{"name":"files.get","args":{"fileId":"00000000-0000-0000-0000-000000000000"}}',
      argsSchema: getArgs,
      classification: 'READ',
      handler: async (ctx: ToolContext, args: unknown) => {
        const userCheck = requireUser(ctx);
        if (userCheck) return userCheck;

        const { fileId, fileName } = getArgs.parse(args);
        const db = ctx.db as ReturnType<typeof getDb>;

        let file: typeof userFiles.$inferSelect | undefined;
        if (fileId) {
          const [byId] = await db
            .select()
            .from(userFiles)
            .where(and(eq(userFiles.id, fileId), eq(userFiles.userId, ctx.userId!)))
            .limit(1);
          file = byId;
        } else if (fileName) {
          const [exact] = await db
            .select()
            .from(userFiles)
            .where(and(eq(userFiles.userId, ctx.userId!), eq(userFiles.fileName, fileName)))
            .orderBy(desc(userFiles.createdAt))
            .limit(1);
          if (exact) {
            file = exact;
          } else {
            const pattern = `%${fileName}%`;
            const [fuzzy] = await db
              .select()
              .from(userFiles)
              .where(
                and(eq(userFiles.userId, ctx.userId!), sql`${userFiles.fileName} ILIKE ${pattern}`)
              )
              .orderBy(desc(userFiles.createdAt))
              .limit(1);
            file = fuzzy;
          }
        }

        if (!file) return { success: false, error: 'File not found' };
        return { success: true, file: toFileItem(file) };
      },
    },
    {
      name: 'read_text',
      shortDescription: 'Read indexed text content from a file',
      longDescription:
        'Returns extracted text from a file when available. Text is truncated to maxChars (default 3000). Use the totalLength field to see if more text is available. Useful for analyzing uploaded text documents and creating custom summaries.',
      usageExample: '{"name":"files.read_text","args":{"fileId":"00000000-0000-0000-0000-000000000000"}}',
      argsSchema: readTextArgs,
      classification: 'READ',
      handler: async (ctx: ToolContext, args: unknown) => {
        const userCheck = requireUser(ctx);
        if (userCheck) return userCheck;

        const { fileId, maxChars = 3000 } = readTextArgs.parse(args);
        const toolConfig = getFilesToolConfig(ctx);
        const db = ctx.db as ReturnType<typeof getDb>;
        const [file] = await db
          .select()
          .from(userFiles)
          .where(and(eq(userFiles.id, fileId), eq(userFiles.userId, ctx.userId!)))
          .limit(1);

        if (!file) return { success: false, error: 'File not found' };
        let text = file.extractedText ?? '';
        let source: 'indexed' | 'text' | 'officeparser' | 'binary_fallback' | 'unsupported' | 'disabled' | 'officeparser_error' =
          'indexed';
        let extractionError: string | undefined;

        if (!text) {
          const extracted = await extractFileText(file, toolConfig);
          text = extracted.text;
          source = extracted.source;
          extractionError = extracted.error;

          if (text && toolConfig.persist_extracted_text) {
            await db
              .update(userFiles)
              .set({
                extractedText: text.slice(0, Math.max(toolConfig.extraction_max_chars, 30000)),
                updatedAt: new Date(),
              })
              .where(and(eq(userFiles.id, file.id), eq(userFiles.userId, ctx.userId!)));
          }
        }

        if (!text) {
          const reason =
            source === 'disabled'
              ? 'Text extraction is disabled by tool config.'
              : source === 'officeparser_error'
                ? `officeparser failed: ${extractionError ?? 'unknown parser error'}`
                : 'No readable text extracted for this file type.';
          return {
            success: false,
            error: reason,
            file: toFileItem(file),
            source,
          };
        }

        const textToReturn = text.slice(0, maxChars);
        return {
          success: true,
          file: toFileItem(file),
          text: textToReturn,
          truncated: text.length > maxChars,
          totalLength: text.length,
          source,
        };
      },
    },
    {
      name: 'update_summary',
      shortDescription: 'Update stored summary for a file',
      longDescription:
        'Stores a curated summary for a file. This is useful after the model inspects content and wants better future retrieval.',
      usageExample:
        '{"name":"files.update_summary","args":{"fileId":"00000000-0000-0000-0000-000000000000","summary":"Quarterly planning notes and action items"}}',
      argsSchema: updateSummaryArgs,
      classification: 'WRITE',
      handler: async (ctx: ToolContext, args: unknown) => {
        const userCheck = requireUser(ctx);
        if (userCheck) return userCheck;

        const { fileId, summary } = updateSummaryArgs.parse(args);
        const db = ctx.db as ReturnType<typeof getDb>;
        const [file] = await db
          .update(userFiles)
          .set({ summary, updatedAt: new Date() })
          .where(and(eq(userFiles.id, fileId), eq(userFiles.userId, ctx.userId!)))
          .returning();

        if (!file) return { success: false, error: 'File not found' };
        return { success: true, file: toFileItem(file) };
      },
    },
  ],
};
