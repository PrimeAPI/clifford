import path from 'path';
import { createHash } from 'crypto';
import { config } from '../../config.js';

const TEXT_MIME_PREFIXES = ['text/'];
const TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/typescript',
  'application/x-yaml',
  'application/yaml',
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

export function decodeBase64Payload(raw: string) {
  const normalized = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
  return Buffer.from(normalized, 'base64');
}

export function sha256Hex(buffer: Buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function sanitizeFileName(input: string) {
  const basename = path.basename(input).trim();
  const safe = basename.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, ' ');
  return safe || 'file';
}

export function shouldInlinePreview(mimeType: string) {
  const lower = mimeType.toLowerCase();
  return lower.startsWith('image/') || lower.startsWith('audio/');
}

export function contentDispositionFor(mimeType: string, fileName: string) {
  const safe = sanitizeFileName(fileName).replace(/"/g, '');
  if (shouldInlinePreview(mimeType)) {
    return `inline; filename="${safe}"`;
  }
  return `attachment; filename="${safe}"`;
}

export function extractTextForIndexing({
  mimeType,
  fileName,
  content,
}: {
  mimeType: string;
  fileName: string;
  content: Buffer;
}) {
  const lowerMime = mimeType.toLowerCase();
  const ext = path.extname(fileName).toLowerCase();

  const isText =
    TEXT_MIME_PREFIXES.some((prefix) => lowerMime.startsWith(prefix)) ||
    TEXT_MIME_TYPES.has(lowerMime) ||
    TEXT_EXTENSIONS.has(ext);

  if (!isText) return '';

  const raw = content.toString('utf8').replace(/\0/g, '');
  return raw.slice(0, config.maxExtractedTextChars);
}

export function buildDefaultSummary(extractedText: string) {
  const normalized = extractedText.trim().replace(/\s+/g, ' ');
  if (!normalized) return null;
  return normalized.slice(0, 280);
}
