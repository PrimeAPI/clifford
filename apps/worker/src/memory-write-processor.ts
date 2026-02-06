import type { Job } from 'bullmq';
import type { Logger, MemoryWriteJob } from '@clifford/sdk';
import { getDb, memoryItems, messages, userSettings } from '@clifford/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { config } from './config.js';
import { decryptSecret } from '@clifford/core';
import { callOpenAIWithFallback, type OpenAIMessage } from './openai-client.js';
import { z } from 'zod';

const LEVEL_LIMITS = [
  { level: 0, maxItems: 4, maxChars: 50 },
  { level: 1, maxItems: 8, maxChars: 120 },
  { level: 2, maxItems: 10, maxChars: 180 },
  { level: 3, maxItems: 12, maxChars: 200 },
  { level: 4, maxItems: 12, maxChars: 240 },
  { level: 5, maxItems: 6, maxChars: 300 },
];

const MEMORY_MODULES = [
  'identity',
  'preferences',
  'constraints',
  'projects',
  'relationships',
  'environment',
  'recent_context',
];

const memoryOpSchema = z.object({
  op: z.enum(['add', 'update', 'delete', 'touch']),
  id: z.string().optional(),
  module: z.string().optional(),
  key: z.string().optional(),
  level: z.number().int().min(0).max(5).optional(),
  value: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

const memoryOpListSchema = z.array(memoryOpSchema);

type MemoryOp = z.infer<typeof memoryOpSchema>;

type MemoryItemRow = typeof memoryItems.$inferSelect;

export async function processMemoryWrite(job: Job<MemoryWriteJob>, logger: Logger) {
  const { contextId, userId, mode, segmentMessages } = job.data;
  const db = getDb();
  const now = new Date();

  const [settings] = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);

  if (!settings || !settings.llmApiKeyEncrypted) {
    logger.warn({ contextId, userId }, 'Memory write skipped: missing LLM API key');
    return { ok: false, reason: 'missing_api_key' };
  }

  if (settings.memoryEnabled === false) {
    logger.info({ contextId, userId }, 'Memory write skipped: memory disabled');
    return { ok: false, reason: 'memory_disabled' };
  }

  if (!settings.llmApiKeyIv || !settings.llmApiKeyTag) {
    logger.error({ contextId, userId }, 'Memory write skipped: missing key metadata');
    return { ok: false, reason: 'missing_key_metadata' };
  }

  if (!config.encryptionKey) {
    logger.error({ contextId, userId }, 'Memory write skipped: missing encryption key');
    return { ok: false, reason: 'missing_encryption_key' };
  }

  const apiKey = decryptSecret(
    settings.llmApiKeyEncrypted,
    settings.llmApiKeyIv,
    settings.llmApiKeyTag,
    config.encryptionKey
  ).trim();

  if (!apiKey.startsWith('sk-')) {
    logger.error({ contextId, userId }, 'Memory write skipped: invalid API key');
    return { ok: false, reason: 'invalid_api_key' };
  }

  const provider = settings.llmProvider || 'openai';
  const model = settings.llmModel || 'gpt-4o-mini';
  const fallbackModel = settings.llmFallbackModel || null;

  const segment =
    segmentMessages && segmentMessages.length > 0
      ? segmentMessages.slice(-config.memoryWriterMaxMessages)
      : await loadContextMessages(db, contextId, config.memoryWriterMaxMessages);

  if (segment.length === 0) {
    logger.info({ contextId, userId }, 'Memory write skipped: empty segment');
    return { ok: false, reason: 'empty_segment' };
  }

  const activeMemories = await loadActiveMemories(db, userId, now);
  const memoryPrompt = formatActiveMemories(activeMemories);
  const segmentPrompt = formatSegment(segment);

  const systemPrompt =
    'You are the memory-writer. Extract durable, non-sensitive memories from the segment. ' +
    'Output ONLY a JSON array of operations. No prose, no markdown. ' +
    'Do NOT return [] if the segment contains any stable or location facts (e.g., where the user lives), ' +
    'recurring preferences, long-lived projects, or clear recent context that helps future replies. ' +
    'Use [] ONLY when there is truly nothing to remember. ' +
    'Operations: add(level,module,key,value,confidence), ' +
    'update(id or module+key, value, confidence), ' +
    'delete(id or module+key), touch(id or module+key). ' +
    'Use numeric level 0-5. ' +
    'Use modules: identity, preferences, constraints, projects, relationships, environment, recent_context. ' +
    'Keys must be snake_case and short. ' +
    'Higher levels should include more detailed, conversation-specific memories. ' +
    'Lower levels are durable preferences/identity/constraints. Never store secrets. ' +
    'Examples (output only JSON): ' +
    '[{"op":"add","level":3,"module":"environment","key":"location","value":"Bremen, Germany","confidence":0.5}] ' +
    '[{"op":"add","level":5,"module":"recent_context","key":"topic","value":"weather in northern Germany","confidence":0.6}] ' +
    '[{"op":"add","level":1,"module":"identity","key":"name","value":"Alex","confidence":0.7}]';

  const userPrompt =
    `Mode: ${mode}\n\n` +
    `Segment (most recent ${segment.length} messages):\n${segmentPrompt}\n\n` +
    `Active memories:\n${memoryPrompt}\n\n` +
    'Return JSON array of ops.';

  const messagesForModel: OpenAIMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  if (provider !== 'openai') {
    logger.error({ provider }, 'Memory write skipped: unsupported provider');
    return { ok: false, reason: 'unsupported_provider' };
  }

  let responseText = '';
  try {
    responseText = await callOpenAIWithFallback(
      apiKey,
      model,
      fallbackModel,
      messagesForModel,
      { temperature: 0 }
    );
  } catch (err) {
    logger.error({ err, contextId, userId }, 'Memory writer model call failed');
    return { ok: false, reason: 'model_call_failed' };
  }

  const operations = parseMemoryOps(responseText, logger);
  if (!operations) {
    logger.warn({ contextId, userId }, 'Memory write skipped: invalid operations');
    return { ok: false, reason: 'invalid_operations', rawResponse: responseText.slice(0, 2000) };
  }

  const result = await applyMemoryOps({
    db,
    userId,
    contextId,
    now,
    ops: operations,
    logger,
  });

  return {
    ok: true,
    operations: result.applied,
    skipped: result.skipped,
    rawResponse: responseText.slice(0, 2000),
  };
}

async function loadContextMessages(
  db: ReturnType<typeof getDb>,
  contextId: string,
  limit: number
) {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.contextId, contextId))
    .orderBy(desc(messages.createdAt))
    .limit(limit);

  return rows
    .reverse()
    .map((row) => ({
    direction: row.direction,
    content: row.content,
    createdAt: row.createdAt?.toISOString?.() ?? undefined,
  }));
}

function formatSegment(segment: Array<{ direction: string; content: string }>) {
  return segment
    .map((entry) => `${entry.direction === 'inbound' ? 'User' : 'Assistant'}: ${entry.content}`)
    .join('\n');
}

async function loadActiveMemories(
  db: ReturnType<typeof getDb>,
  userId: string,
  _now: Date
): Promise<MemoryItemRow[]> {
  const rows = await db
    .select()
    .from(memoryItems)
    .where(and(eq(memoryItems.userId, userId), eq(memoryItems.archived, false)));

  return rows;
}

function formatActiveMemories(items: MemoryItemRow[]) {
  if (items.length === 0) {
    return '(none)';
  }

  return items
    .map(
      (item) =>
        `[${item.id}] L${item.level} ${item.module}.${item.key}: ${item.value} (conf ${item.confidence.toFixed(
          2
        )})`
    )
    .join('\n');
}

function parseMemoryOps(responseText: string, logger: Logger): MemoryOp[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch (err) {
    const extracted = extractJsonArray(responseText);
    if (!extracted) {
      logger.warn({ err, responseText }, 'Memory writer returned non-JSON');
      return null;
    }
    parsed = extracted;
  }

  const candidate = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed
      ? (parsed as { operations?: unknown }).operations
      : null;

  const normalized = normalizeMemoryOps(candidate);
  const result = memoryOpListSchema.safeParse(normalized);
  if (!result.success) {
    logger.warn({ issues: result.error.issues }, 'Memory writer returned invalid ops');
    return null;
  }

  return result.data;
}

function normalizeMemoryOps(candidate: unknown): unknown {
  if (!Array.isArray(candidate)) return candidate;
  return candidate.map((entry) => {
    if (typeof entry !== 'object' || entry === null) return entry;
    const raw = entry as Record<string, unknown>;
    const opValue =
      raw.op ??
      raw.action ??
      raw.type ??
      raw.operation ??
      raw.intent ??
      raw.kind ??
      raw.command;
    const op = typeof opValue === 'string' ? opValue.toLowerCase() : opValue;
    const levelValue = raw.level;
    const level =
      typeof levelValue === 'string'
        ? Number.parseInt(levelValue, 10)
        : typeof levelValue === 'number'
          ? levelValue
          : levelValue;
    const confidenceValue = raw.confidence;
    const confidence =
      typeof confidenceValue === 'string'
        ? Number.parseFloat(confidenceValue)
        : confidenceValue;
    return {
      ...raw,
      op,
      level,
      confidence,
      value: raw.value ?? raw.new_value ?? raw.newValue,
    };
  });
}

function buildHeuristicOps(
  segment: Array<{ direction: string; content: string }>
): MemoryOp[] {
  const ops: MemoryOp[] = [];
  const inbound = segment.filter((entry) => entry.direction === 'inbound');
  for (const entry of inbound) {
    const name = extractName(entry.content);
    if (name) {
      ops.push(
        {
          op: 'add',
          level: 1,
          module: 'identity',
          key: 'name',
          value: name,
          confidence: 0.7,
        }
      );
      break;
    }
  }

  const location = extractLocation(inbound.map((entry) => entry.content));
  if (location) {
    ops.push({
      op: 'add',
      level: 3,
      module: 'environment',
      key: 'location',
      value: location,
      confidence: 0.5,
    });
  }

  const topic = extractRecentTopic(segment, location);
  if (topic) {
    ops.push({
      op: 'add',
      level: 5,
      module: 'recent_context',
      key: 'topic',
      value: topic,
      confidence: 0.6,
    });
  }

  return ops;
}

function extractName(text: string) {
  const patterns = [
    /my name is\\s+([A-Za-z\\u00C0-\\u024F'’\\-]+)/i,
    /i am\\s+([A-Za-z\\u00C0-\\u024F'’\\-]+)/i,
    /i'm\\s+([A-Za-z\\u00C0-\\u024F'’\\-]+)/i,
    /ich hei[\\u00DFs]e\\s+([A-Za-z\\u00C0-\\u024F'’\\-]+)/i,
    /ich bin\\s+([A-Za-z\\u00C0-\\u024F'’\\-]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  return '';
}

function extractLocation(messages: string[]) {
  const patterns = [
    /\b(?:i\s*am|i'm|im|i\s*live|i\s*live\s*in|i\s*am\s*in|i'm\s*in|im\s*in)\s+([A-Za-z\u00C0-\u024F'’\-\s]+)/i,
    /\b(?:ich\s*wohne(?:\s*ja)?|ich\s*lebe|ich\s*bin)\s+(?:in\s+)?([A-Za-z\u00C0-\u024F'’\-\s]+)/i,
    /\b(?:its|it's|it\s+is)\s+([A-Za-z\u00C0-\u024F'’\-\s]+)/i,
  ];

  for (const text of messages) {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        let value = match[1].trim().replace(/\s+/g, ' ');
        value = value
          .replace(/[?.!]+$/g, '')
          .replace(/\s*,\s*und\s*du\s*$/i, '')
          .replace(/\s*,\s*oder\s*$/i, '')
          .trim();
        if (value.length >= 3 && value.length <= 80) {
          return value;
        }
      }
    }
  }

  return '';
}

function extractRecentTopic(
  segment: Array<{ direction: string; content: string }>,
  location?: string
) {
  const text = segment.map((entry) => entry.content.toLowerCase()).join(' ');
  if (text.includes('weather')) {
    return location ? `weather in ${location}` : 'weather';
  }

  return '';
}

function extractJsonArray(responseText: string): unknown[] | null {
  const start = responseText.indexOf('[');
  const end = responseText.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  const candidate = responseText.slice(start, end + 1);
  try {
    const parsed = JSON.parse(candidate);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function containsSecret(value: string) {
  const lower = value.toLowerCase();
  if (
    lower.includes('password:') ||
    lower.includes('api key') ||
    lower.includes('secret') ||
    lower.includes('token') ||
    lower.includes('private key')
  ) {
    return true;
  }

  const patterns = [
    /sk-[a-z0-9]{20,}/i,
    /-----begin (?:rsa|dsa|ec|openssh|private) key-----/i,
    /akia[0-9a-z]{16}/i,
  ];

  return patterns.some((pattern) => pattern.test(value));
}

function sanitizeValue(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function maxCharForLevel(level: number) {
  return LEVEL_LIMITS.find((limit) => limit.level === level)?.maxChars ?? 120;
}

function clampConfidence(value: number | undefined) {
  if (value === undefined) return 0.6;
  return Math.min(1, Math.max(0, value));
}

async function applyMemoryOps({
  db,
  userId,
  contextId,
  now,
  ops,
  logger,
}: {
  db: ReturnType<typeof getDb>;
  userId: string;
  contextId: string;
  now: Date;
  ops: MemoryOp[];
  logger: Logger;
}) {
  let applied = 0;
  let skipped = 0;
  const existing = await db
    .select()
    .from(memoryItems)
    .where(eq(memoryItems.userId, userId));

  const byId = new Map(existing.map((item) => [item.id, item]));
  const byModuleKey = new Map(
    existing.map((item) => [`${item.module}:${item.key}`, item])
  );

  for (const op of ops) {
    const moduleKey = op.module && op.key ? `${op.module}:${op.key}` : null;
    const target = op.id ? byId.get(op.id) : moduleKey ? byModuleKey.get(moduleKey) : undefined;

    if (op.op === 'delete') {
      if (!target) {
        skipped += 1;
        continue;
      }
      await db.delete(memoryItems).where(eq(memoryItems.id, target.id));
      applied += 1;
      continue;
    }

    if (op.op === 'touch') {
      if (!target) {
        skipped += 1;
        continue;
      }
      await db
        .update(memoryItems)
        .set({ lastSeenAt: now, archived: false })
        .where(eq(memoryItems.id, target.id));
      applied += 1;
      continue;
    }

    if (op.op === 'update') {
      if (!target) {
        skipped += 1;
        continue;
      }
      const nextValue = op.value ? sanitizeValue(op.value) : target.value;
      if (containsSecret(nextValue) || containsSecret(target.key)) {
        skipped += 1;
        continue;
      }

      const level = op.level ?? target.level;
      const maxChars = maxCharForLevel(level);
      const finalValue = nextValue.slice(0, maxChars);
      await db
        .update(memoryItems)
        .set({
          value: finalValue,
          level,
          confidence: clampConfidence(op.confidence ?? target.confidence),
          lastSeenAt: now,
          contextId,
          archived: false,
        })
        .where(eq(memoryItems.id, target.id));
      applied += 1;
      continue;
    }

    if (op.op === 'add') {
      if (!op.module || !op.key || op.level === undefined || !op.value) {
        skipped += 1;
        continue;
      }

      const normalizedValue = sanitizeValue(op.value);
      if (!normalizedValue || containsSecret(normalizedValue) || containsSecret(op.key)) {
        skipped += 1;
        continue;
      }

      const module = op.module.trim();
      if (!MEMORY_MODULES.includes(module)) {
        skipped += 1;
        continue;
      }

      const maxChars = maxCharForLevel(op.level);
      const finalValue = normalizedValue.slice(0, maxChars);
      if (moduleKey && byModuleKey.has(moduleKey)) {
        const existingItem = byModuleKey.get(moduleKey);
        if (existingItem) {
          await db
            .update(memoryItems)
            .set({
              value: finalValue,
              level: op.level,
              confidence: clampConfidence(op.confidence),
              lastSeenAt: now,
              contextId,
              archived: false,
            })
            .where(eq(memoryItems.id, existingItem.id));
          applied += 1;
          continue;
        }
      }

      await db.insert(memoryItems).values({
        userId,
        level: op.level,
        module,
        key: op.key,
        value: finalValue,
        confidence: clampConfidence(op.confidence),
        contextId,
        pinned: false,
        archived: false,
        createdAt: now,
        lastSeenAt: now,
      });
      applied += 1;
    }
  }

  await dedupeAndEnforceCaps(db, userId, logger);

  return { applied, skipped };
}

async function dedupeAndEnforceCaps(
  db: ReturnType<typeof getDb>,
  userId: string,
  logger: Logger
) {
  const items = await db
    .select()
    .from(memoryItems)
    .where(and(eq(memoryItems.userId, userId), eq(memoryItems.archived, false)));

  for (const item of items) {
    const maxChars = maxCharForLevel(item.level);
    if (item.value.length > maxChars) {
      await db
        .update(memoryItems)
        .set({ value: item.value.slice(0, maxChars) })
        .where(eq(memoryItems.id, item.id));
    }
  }

  const grouped = new Map<string, MemoryItemRow[]>();
  for (const item of items) {
    const key = `${item.module}:${item.key}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(item);
    grouped.set(key, bucket);
  }

  for (const bucket of grouped.values()) {
    if (bucket.length <= 1) continue;
    bucket.sort((a, b) => (b.lastSeenAt?.getTime?.() ?? 0) - (a.lastSeenAt?.getTime?.() ?? 0));
    const [, ...dupes] = bucket;
    const dupIds = dupes.map((item) => item.id);
    if (dupIds.length > 0) {
      await db
        .update(memoryItems)
        .set({ archived: true })
        .where(and(eq(memoryItems.userId, userId), inArray(memoryItems.id, dupIds)));
    }
  }

  const normalizedGrouped = new Map<string, MemoryItemRow[]>();
  for (const item of items) {
    const normalized = normalizeValue(item.value);
    if (!normalized) continue;
    const key = `${item.module}:${normalized}`;
    const bucket = normalizedGrouped.get(key) ?? [];
    bucket.push(item);
    normalizedGrouped.set(key, bucket);
  }

  for (const bucket of normalizedGrouped.values()) {
    if (bucket.length <= 1) continue;
    bucket.sort((a, b) => (b.lastSeenAt?.getTime?.() ?? 0) - (a.lastSeenAt?.getTime?.() ?? 0));
    const [, ...dupes] = bucket;
    const dupIds = dupes.map((item) => item.id);
    if (dupIds.length > 0) {
      await db
        .update(memoryItems)
        .set({ archived: true })
        .where(and(eq(memoryItems.userId, userId), inArray(memoryItems.id, dupIds)));
    }
  }

  const refreshed = await db
    .select()
    .from(memoryItems)
    .where(and(eq(memoryItems.userId, userId), eq(memoryItems.archived, false)));

  for (const limit of LEVEL_LIMITS) {
    const levelItems = refreshed.filter((item) => item.level === limit.level);
    if (levelItems.length <= limit.maxItems) {
      continue;
    }

    const candidates = levelItems
      .filter((item) => !item.pinned)
      .sort((a, b) => {
        const aSeen = a.lastSeenAt?.getTime?.() ?? 0;
        const bSeen = b.lastSeenAt?.getTime?.() ?? 0;
        return aSeen - bSeen;
      });

    const overflow = levelItems.length - limit.maxItems;
    const toArchive = candidates.slice(0, overflow);
    if (toArchive.length === 0) {
      logger.warn({ level: limit.level }, 'Memory cap exceeded but no evictable items');
      continue;
    }

    await db
      .update(memoryItems)
      .set({ archived: true })
      .where(
        and(eq(memoryItems.userId, userId), inArray(memoryItems.id, toArchive.map((i) => i.id)))
      );
  }
}

function normalizeValue(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
