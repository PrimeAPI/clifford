import type { FastifyInstance } from 'fastify';
import { getDb, userToolSettings } from '@clifford/db';
import { and, eq } from 'drizzle-orm';
import { updateToolSchema } from './tools.schema.js';
import { loadAllTools } from './tools.service.js';

export async function toolRoutes(app: FastifyInstance) {
  app.get('/api/tools', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const db = getDb();
    const settings = await db
      .select()
      .from(userToolSettings)
      .where(eq(userToolSettings.userId, userId));

    const settingsMap = new Map(settings.map((row) => [row.toolName, row]));
    const hasUserSettings = settings.length > 0;
    const tools = loadAllTools().map((tool) => {
      const setting = settingsMap.get(tool.name);
      return {
        name: tool.name,
        shortDescription: tool.shortDescription,
        longDescription: tool.longDescription,
        commands: tool.commands.map((command) => ({
          name: command.name,
          shortDescription: command.shortDescription,
        })),
        configFields: tool.config?.fields ?? [],
        enabled: setting?.enabled ?? true,
        pinned: setting?.pinned ?? (hasUserSettings ? false : tool.pinned ?? false),
        important: setting?.important ?? (hasUserSettings ? false : tool.important ?? false),
        config: setting?.config ?? {},
      };
    });

    return { tools };
  });

  app.put<{ Params: { name: string } }>('/api/tools/:name', async (req, reply) => {
    const userId = req.headers['x-user-id'] as string;
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { name } = req.params;
    const body = updateToolSchema.parse(req.body);

    const tool = loadAllTools().find((item) => item.name === name);
    if (!tool) {
      return reply.status(404).send({ error: 'Tool not found' });
    }

    if (body.config && tool.config?.schema) {
      const parsed = tool.config.schema.safeParse(body.config);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid config', issues: parsed.error.issues });
      }
    }

    const db = getDb();

    if (body.pinned === true) {
      await db
        .update(userToolSettings)
        .set({ pinned: false, updatedAt: new Date() })
        .where(eq(userToolSettings.userId, userId));
    }

    if (body.important === true) {
      await db
        .update(userToolSettings)
        .set({ important: false, updatedAt: new Date() })
        .where(eq(userToolSettings.userId, userId));
    }

    const nextPinned = body.pinned ?? false;
    const nextImportant = nextPinned ? false : body.important ?? false;

    const updateSet: Record<string, unknown> = { updatedAt: new Date() };
    if (body.enabled !== undefined) updateSet.enabled = body.enabled;
    if (body.pinned !== undefined) updateSet.pinned = nextPinned;
    if (body.important !== undefined) updateSet.important = nextImportant;
    if (body.config !== undefined) updateSet.config = body.config;

    const [updated] = await db
      .insert(userToolSettings)
      .values({
        userId,
        toolName: name,
        enabled: body.enabled ?? true,
        pinned: nextPinned,
        important: nextImportant,
        config: body.config ?? {},
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [userToolSettings.userId, userToolSettings.toolName],
        set: updateSet,
      })
      .returning();

    if (updated && updated.enabled === false) {
      await db
        .update(userToolSettings)
        .set({ pinned: false, important: false, updatedAt: new Date() })
        .where(and(eq(userToolSettings.userId, userId), eq(userToolSettings.toolName, name)));
    }

    return { success: true };
  });
}
