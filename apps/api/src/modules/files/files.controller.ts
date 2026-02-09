import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import path from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { and, desc, eq } from 'drizzle-orm';
import { getDb, channels, contexts, userFiles } from '@clifford/db';
import { config } from '../../config.js';
import { listFilesQuerySchema, updateFileSummarySchema, uploadFileSchema } from './files.schema.js';
import {
  buildDefaultSummary,
  contentDispositionFor,
  decodeBase64Payload,
  extractTextForIndexing,
  sanitizeFileName,
  sha256Hex,
  shouldInlinePreview,
} from './files.service.js';

function toFileResponse(file: typeof userFiles.$inferSelect) {
  return {
    id: file.id,
    userId: file.userId,
    channelId: file.channelId,
    contextId: file.contextId,
    fileName: file.fileName,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
    summary: file.summary,
    hasExtractedText: Boolean(file.extractedText?.trim()),
    canInlinePreview: shouldInlinePreview(file.mimeType),
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
  };
}

export async function fileRoutes(app: FastifyInstance) {
  app.post('/api/files', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const body = uploadFileSchema.parse(req.body);
    const db = getDb();

    const [channel] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.id, body.channelId), eq(channels.userId, userId)))
      .limit(1);
    if (!channel) {
      return reply.status(404).send({ error: 'Channel not found' });
    }

    if (body.contextId) {
      const [context] = await db
        .select()
        .from(contexts)
        .where(and(eq(contexts.id, body.contextId), eq(contexts.channelId, channel.id)))
        .limit(1);
      if (!context) {
        return reply.status(400).send({ error: 'Context not found for channel' });
      }
    }

    const content = decodeBase64Payload(body.dataBase64);
    if (content.length === 0) {
      return reply.status(400).send({ error: 'Empty file payload' });
    }
    if (content.length > config.maxUploadBytes) {
      return reply.status(413).send({ error: `File too large. Max ${config.maxUploadBytes} bytes.` });
    }

    const fileId = randomUUID();
    const safeName = sanitizeFileName(body.fileName);
    const userDir = path.resolve(config.fileStorageDir, userId);
    const storagePath = path.resolve(userDir, `${fileId}-${safeName}`);
    if (!storagePath.startsWith(userDir)) {
      return reply.status(400).send({ error: 'Invalid file path' });
    }

    await mkdir(userDir, { recursive: true });
    await writeFile(storagePath, content, { flag: 'wx' });

    const mimeType = body.mimeType?.trim() || 'application/octet-stream';
    const extractedText = extractTextForIndexing({ mimeType, fileName: safeName, content });
    const summary = buildDefaultSummary(extractedText);

    const [file] = await db
      .insert(userFiles)
      .values({
        id: fileId,
        userId,
        channelId: channel.id,
        contextId: body.contextId ?? null,
        fileName: safeName,
        mimeType,
        sizeBytes: content.length,
        storagePath,
        sha256: sha256Hex(content),
        extractedText: extractedText || null,
        summary,
      })
      .returning();

    app.log.info(
      { fileId: file?.id, userId, channelId: channel.id, sizeBytes: content.length },
      'User file uploaded'
    );

    return { file: file ? toFileResponse(file) : null };
  });

  app.get('/api/files', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const query = listFilesQuerySchema.parse(req.query);
    const db = getDb();

    const filters = [eq(userFiles.userId, userId)];
    if (query.channelId) filters.push(eq(userFiles.channelId, query.channelId));
    if (query.contextId) filters.push(eq(userFiles.contextId, query.contextId));

    const rows = await db
      .select()
      .from(userFiles)
      .where(and(...filters))
      .orderBy(desc(userFiles.createdAt))
      .limit(query.limit ?? 100);

    return { files: rows.map(toFileResponse) };
  });

  app.get<{ Params: { id: string } }>('/api/files/:id', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { id } = req.params;
    const db = getDb();
    const [file] = await db
      .select()
      .from(userFiles)
      .where(and(eq(userFiles.id, id), eq(userFiles.userId, userId)))
      .limit(1);
    if (!file) {
      return reply.status(404).send({ error: 'File not found' });
    }

    return { file: toFileResponse(file) };
  });

  app.get<{ Params: { id: string } }>('/api/files/:id/content', async (req, reply) => {
    const userIdHeader = req.headers['x-user-id'] as string | undefined;
    const deliveryToken = req.headers['x-delivery-token'] as string | undefined;
    const deliveryUserId = req.headers['x-delivery-user-id'] as string | undefined;
    const isDeliveryAuthorized = Boolean(
      deliveryToken && config.deliveryToken && deliveryToken === config.deliveryToken && deliveryUserId
    );
    const userId = userIdHeader || (isDeliveryAuthorized ? deliveryUserId : undefined);
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { id } = req.params;
    const db = getDb();
    const [file] = await db
      .select()
      .from(userFiles)
      .where(and(eq(userFiles.id, id), eq(userFiles.userId, userId)))
      .limit(1);
    if (!file) {
      return reply.status(404).send({ error: 'File not found' });
    }

    const content = await readFile(file.storagePath);
    reply
      .header('Content-Type', file.mimeType)
      .header('Content-Length', String(content.length))
      .header('Content-Disposition', contentDispositionFor(file.mimeType, file.fileName));

    return reply.send(content);
  });

  app.patch<{ Params: { id: string } }>('/api/files/:id/summary', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { id } = req.params;
    const body = updateFileSummarySchema.parse(req.body);
    const db = getDb();
    const [file] = await db
      .update(userFiles)
      .set({
        summary: body.summary,
        updatedAt: new Date(),
      })
      .where(and(eq(userFiles.id, id), eq(userFiles.userId, userId)))
      .returning();
    if (!file) {
      return reply.status(404).send({ error: 'File not found' });
    }

    return { file: toFileResponse(file) };
  });
}
