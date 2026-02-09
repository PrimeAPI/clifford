import type { FastifyInstance } from 'fastify';
import { getDb, userToolSettings } from '@clifford/db';
import { and, eq } from 'drizzle-orm';
import type { ToolActivationStatus, ToolCatalogEntry } from '@clifford/sdk';
import { updateToolSchema } from './tools.schema.js';
import { loadAllTools } from './tools.service.js';

function getActivationStatus(
  fields: Array<{
    key: string;
    required?: boolean;
    defaultValue?: string | number | boolean;
  }>,
  config: Record<string, unknown>
): ToolActivationStatus {
  const missingRequiredFields = fields
    .filter((field) => {
      if (!field.required) return false;
      const hasValue = config[field.key] !== undefined && config[field.key] !== null && config[field.key] !== '';
      const hasDefault = field.defaultValue !== undefined;
      return !hasValue && !hasDefault;
    })
    .map((field) => field.key);

  return {
    requiresConfiguration: missingRequiredFields.length > 0,
    canActivate: missingRequiredFields.length === 0,
    missingRequiredFields,
  };
}

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
    const tools: ToolCatalogEntry[] = loadAllTools().map((tool) => {
      const setting = settingsMap.get(tool.name);
      const config = (setting?.config ?? {}) as Record<string, unknown>;
      const configFields = tool.config?.fields ?? [];
      const activation = getActivationStatus(configFields, config);
      const enabled = activation.canActivate ? (setting?.enabled ?? true) : false;
      const pinned = enabled
        ? (setting?.pinned ?? (hasUserSettings ? false : (tool.pinned ?? false)))
        : false;
      const important = enabled
        ? (setting?.important ?? (hasUserSettings ? false : (tool.important ?? false)))
        : false;
      return {
        name: tool.name,
        icon: tool.icon,
        shortDescription: tool.shortDescription,
        longDescription: tool.longDescription,
        commands: tool.commands.map((command) => ({
          name: command.name,
          shortDescription: command.shortDescription,
        })),
        configFields,
        activation,
        enabled,
        pinned,
        important,
        config,
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
    const existing = await db
      .select()
      .from(userToolSettings)
      .where(and(eq(userToolSettings.userId, userId), eq(userToolSettings.toolName, name)))
      .limit(1);
    const existingRow = existing[0];
    const mergedConfig = {
      ...((existingRow?.config ?? {}) as Record<string, unknown>),
      ...(body.config ?? {}),
    };
    const activation = getActivationStatus(tool.config?.fields ?? [], mergedConfig);
    const nextEnabled = body.enabled ?? existingRow?.enabled ?? true;
    if (nextEnabled && !activation.canActivate) {
      return reply.status(400).send({
        error: 'Configuration required before enabling this tool',
        missingRequiredFields: activation.missingRequiredFields,
      });
    }

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
    const nextImportant = nextPinned ? false : (body.important ?? false);

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
