import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, memoryItems, userSettings, users } from '@clifford/db';
import { and, eq, inArray } from 'drizzle-orm';

const DEMO_USER_EMAIL = 'demo@clifford.ai';
const DEMO_USER_NAME = 'Demo User';

const MEMORY_LOAD_CAP = 1200;
const MEMORY_SELECTION_CAPS: Record<number, number> = {
  0: 5,
  1: 5,
  2: 5,
  3: 5,
  4: 5,
  5: 5,
};

const LEVEL_LIMITS = [
  { level: 0, maxItems: 4, maxChars: 50 },
  { level: 1, maxItems: 8, maxChars: 120 },
  { level: 2, maxItems: 10, maxChars: 180 },
  { level: 3, maxItems: 12, maxChars: 200 },
  { level: 4, maxItems: 12, maxChars: 240 },
  { level: 5, maxItems: 6, maxChars: 300 },
];

const memoryCreateSchema = z.object({
  level: z.number().int().min(0).max(5),
  module: z.string().min(1),
  key: z.string().min(1),
  value: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  pinned: z.boolean().optional(),
});

const memoryUpdateSchema = z.object({
  level: z.number().int().min(0).max(5).optional(),
  module: z.string().min(1).optional(),
  key: z.string().min(1).optional(),
  value: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  pinned: z.boolean().optional(),
});

async function ensureUser(db: ReturnType<typeof getDb>, userId: string) {
  const [existingUser] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!existingUser) {
    await db
      .insert(users)
      .values({
        id: userId,
        email: DEMO_USER_EMAIL,
        name: DEMO_USER_NAME,
      })
      .onConflictDoNothing();
  }
}

async function ensureSettings(db: ReturnType<typeof getDb>, userId: string) {
  const [existingSettings] = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);

  if (existingSettings) {
    return existingSettings;
  }

  const [created] = await db
    .insert(userSettings)
    .values({
      userId,
    })
    .returning();

  return created;
}

export async function memoryRoutes(app: FastifyInstance) {
  app.get('/api/memories', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const db = getDb();
    await ensureUser(db, userId);
    const settings = await ensureSettings(db, userId);

    if (settings?.memoryEnabled === false) {
      return { enabled: false, memories: [] };
    }

    const items = await db
      .select()
      .from(memoryItems)
      .where(and(eq(memoryItems.userId, userId), eq(memoryItems.archived, false)));

    const selected = selectActiveMemories(items);

    return {
      enabled: true,
      memories: selected,
    };
  });

  app.post('/api/memories', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const body = memoryCreateSchema.parse(req.body);
    const db = getDb();
    await ensureUser(db, userId);

    if (containsSecret(body.value) || containsSecret(body.key)) {
      return reply.status(400).send({ error: 'Memory value contains sensitive data' });
    }

    const maxChars = maxCharsForLevel(body.level);
    const value = body.value.slice(0, maxChars);
    const [created] = await db
      .insert(memoryItems)
      .values({
        userId,
        level: body.level,
        module: body.module.trim(),
        key: body.key.trim(),
        value,
        confidence: clampConfidence(body.confidence),
        pinned: body.pinned ?? false,
        archived: false,
        createdAt: new Date(),
        lastSeenAt: new Date(),
      })
      .returning();

    if (created) {
      await enforceCaps(db, userId);
    }

    return { memory: created };
  });

  app.put('/api/memories/:id', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const memoryId = (req.params as { id: string }).id;
    const body = memoryUpdateSchema.parse(req.body);
    const db = getDb();
    await ensureUser(db, userId);

    const [existing] = await db
      .select()
      .from(memoryItems)
      .where(and(eq(memoryItems.userId, userId), eq(memoryItems.id, memoryId)))
      .limit(1);

    if (!existing) {
      return reply.status(404).send({ error: 'Memory not found' });
    }

    const nextLevel = body.level ?? existing.level;
    const maxChars = maxCharsForLevel(nextLevel);
    const nextValue = body.value ? body.value.slice(0, maxChars) : existing.value;

    if (containsSecret(nextValue) || (body.key && containsSecret(body.key))) {
      return reply.status(400).send({ error: 'Memory value contains sensitive data' });
    }

    const [updated] = await db
      .update(memoryItems)
      .set({
        level: nextLevel,
        module: body.module?.trim() ?? existing.module,
        key: body.key?.trim() ?? existing.key,
        value: nextValue,
        confidence: clampConfidence(body.confidence ?? existing.confidence),
        pinned: body.pinned ?? existing.pinned,
        lastSeenAt: new Date(),
        archived: false,
      })
      .where(eq(memoryItems.id, memoryId))
      .returning();

    if (updated) {
      await enforceCaps(db, userId);
    }

    return { memory: updated };
  });

  app.delete('/api/memories/:id', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const memoryId = (req.params as { id: string }).id;
    const db = getDb();
    await ensureUser(db, userId);

    const [existing] = await db
      .select()
      .from(memoryItems)
      .where(and(eq(memoryItems.userId, userId), eq(memoryItems.id, memoryId)))
      .limit(1);

    if (!existing) {
      return reply.status(404).send({ error: 'Memory not found' });
    }

    await db
      .update(memoryItems)
      .set({ archived: true })
      .where(eq(memoryItems.id, memoryId));

    return { success: true };
  });
}

function selectActiveMemories(items: typeof memoryItems.$inferSelect[]) {
  const byLevel = new Map<number, typeof items>();
  for (const item of items) {
    const list = byLevel.get(item.level) ?? [];
    list.push(item);
    byLevel.set(item.level, list);
  }

  for (const list of byLevel.values()) {
    list.sort((a, b) => (b.lastSeenAt?.getTime?.() ?? 0) - (a.lastSeenAt?.getTime?.() ?? 0));
  }

  const selected: typeof items = [];
  for (const level of [0, 1, 2, 3, 4, 5]) {
    const list = byLevel.get(level) ?? [];
    selected.push(...list.slice(0, MEMORY_SELECTION_CAPS[level] ?? 5));
  }

  let totalChars = 0;
  const finalSelection: typeof items = [];
  for (const item of selected) {
    const maxChars = maxCharsForLevel(item.level);
    const value = item.value.length > maxChars ? item.value.slice(0, maxChars) : item.value;
    const line = `- ${item.module}.${item.key}: ${value}`;
    if (totalChars + line.length > MEMORY_LOAD_CAP) {
      break;
    }
    totalChars += line.length;
    finalSelection.push(item);
  }

  return finalSelection;
}

function maxCharsForLevel(level: number) {
  return LEVEL_LIMITS.find((limit) => limit.level === level)?.maxChars ?? 120;
}

function clampConfidence(value: number | undefined) {
  if (value === undefined) return 0.6;
  return Math.min(1, Math.max(0, value));
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

async function enforceCaps(db: ReturnType<typeof getDb>, userId: string) {
  const items = await db
    .select()
    .from(memoryItems)
    .where(and(eq(memoryItems.userId, userId), eq(memoryItems.archived, false)));

  for (const limit of LEVEL_LIMITS) {
    const levelItems = items.filter((item) => item.level === limit.level);
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
      continue;
    }

    await db
      .update(memoryItems)
      .set({ archived: true })
      .where(and(eq(memoryItems.userId, userId), inArray(memoryItems.id, toArchive.map((i) => i.id))));
  }
}
