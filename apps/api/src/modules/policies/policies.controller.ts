import type { FastifyInstance } from 'fastify';
import { getDb, policyRules, quotaUsage, getPeriodStart, type QuotaPeriod } from '@clifford/db';
import { eq, and, desc } from 'drizzle-orm';
import {
  createPolicySchema,
  updatePolicySchema,
  listPoliciesQuerySchema,
  listQuotasQuerySchema,
} from './policies.schema.js';

export async function policyRoutes(app: FastifyInstance) {
  // List policy rules for a tenant
  app.get('/api/policies', async (req, reply) => {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return reply.status(400).send({ error: 'Missing X-Tenant-Id header' });
    }

    const query = listPoliciesQuerySchema.parse(req.query);
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const db = getDb();

    let conditions = eq(policyRules.tenantId, tenantId);
    if (query.agentId) {
      conditions = and(conditions, eq(policyRules.agentId, query.agentId))!;
    }

    const rules = await db
      .select()
      .from(policyRules)
      .where(conditions)
      .orderBy(desc(policyRules.priority))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: db.$count(policyRules, conditions) })
      .from(policyRules);
    const total = countResult[0]?.count ?? 0;

    return {
      policies: rules,
      total,
      limit,
      offset,
      hasMore: offset + rules.length < total,
    };
  });

  // Create a new policy rule
  app.post('/api/policies', async (req, reply) => {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return reply.status(400).send({ error: 'Missing X-Tenant-Id header' });
    }

    const body = createPolicySchema.parse(req.body);
    const db = getDb();

    const ruleResult = await db
      .insert(policyRules)
      .values({
        tenantId,
        agentId: body.agentId ?? null,
        name: body.name,
        description: body.description ?? null,
        priority: body.priority ?? 0,
        conditions: body.conditions,
        action: body.action,
        config: body.config ?? null,
        enabled: body.enabled ?? true,
      })
      .returning();

    const rule = ruleResult[0];
    if (!rule) {
      return reply.status(500).send({ error: 'Failed to create policy rule' });
    }

    app.log.info({ ruleId: rule.id, name: rule.name }, 'Policy rule created');

    return rule;
  });

  // Get a specific policy rule
  app.get<{ Params: { id: string } }>('/api/policies/:id', async (req, reply) => {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return reply.status(400).send({ error: 'Missing X-Tenant-Id header' });
    }

    const { id } = req.params;
    const db = getDb();

    const [rule] = await db
      .select()
      .from(policyRules)
      .where(and(eq(policyRules.id, id), eq(policyRules.tenantId, tenantId)))
      .limit(1);

    if (!rule) {
      return reply.status(404).send({ error: 'Policy rule not found' });
    }

    return rule;
  });

  // Update a policy rule
  app.put<{ Params: { id: string } }>('/api/policies/:id', async (req, reply) => {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return reply.status(400).send({ error: 'Missing X-Tenant-Id header' });
    }

    const { id } = req.params;
    const body = updatePolicySchema.parse(req.body);
    const db = getDb();

    // Verify rule exists and belongs to tenant
    const [existing] = await db
      .select()
      .from(policyRules)
      .where(and(eq(policyRules.id, id), eq(policyRules.tenantId, tenantId)))
      .limit(1);

    if (!existing) {
      return reply.status(404).send({ error: 'Policy rule not found' });
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) updateData.name = body.name;
    if (body.description !== undefined) updateData.description = body.description;
    if (body.priority !== undefined) updateData.priority = body.priority;
    if (body.conditions !== undefined) updateData.conditions = body.conditions;
    if (body.action !== undefined) updateData.action = body.action;
    if (body.config !== undefined) updateData.config = body.config;
    if (body.enabled !== undefined) updateData.enabled = body.enabled;

    const [updated] = await db
      .update(policyRules)
      .set(updateData)
      .where(eq(policyRules.id, id))
      .returning();

    app.log.info({ ruleId: id }, 'Policy rule updated');

    return updated;
  });

  // Delete a policy rule
  app.delete<{ Params: { id: string } }>('/api/policies/:id', async (req, reply) => {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return reply.status(400).send({ error: 'Missing X-Tenant-Id header' });
    }

    const { id } = req.params;
    const db = getDb();

    const [deleted] = await db
      .delete(policyRules)
      .where(and(eq(policyRules.id, id), eq(policyRules.tenantId, tenantId)))
      .returning({ id: policyRules.id });

    if (!deleted) {
      return reply.status(404).send({ error: 'Policy rule not found' });
    }

    app.log.info({ ruleId: id }, 'Policy rule deleted');

    return { success: true, id: deleted.id };
  });

  // Get quota usage for a tenant
  app.get('/api/quotas', async (req, reply) => {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return reply.status(400).send({ error: 'Missing X-Tenant-Id header' });
    }

    const query = listQuotasQuerySchema.parse(req.query);
    const db = getDb();

    let conditions = eq(quotaUsage.tenantId, tenantId);
    if (query.agentId) {
      conditions = and(conditions, eq(quotaUsage.agentId, query.agentId))!;
    }
    if (query.resourceType) {
      conditions = and(conditions, eq(quotaUsage.resourceType, query.resourceType))!;
    }
    if (query.period) {
      conditions = and(conditions, eq(quotaUsage.period, query.period))!;
    }

    const usage = await db
      .select()
      .from(quotaUsage)
      .where(conditions)
      .orderBy(desc(quotaUsage.periodStart));

    return { quotas: usage };
  });

  // Get current period quota summary
  app.get('/api/quotas/current', async (req, reply) => {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return reply.status(400).send({ error: 'Missing X-Tenant-Id header' });
    }

    const db = getDb();
    const periods: QuotaPeriod[] = ['hourly', 'daily', 'monthly'];
    const now = new Date();

    const summary: Record<
      string,
      { period: string; usage: number; limit: number | null; remaining: number | null }[]
    > = {};

    for (const period of periods) {
      const periodStart = getPeriodStart(period, now);

      const usage = await db
        .select()
        .from(quotaUsage)
        .where(
          and(
            eq(quotaUsage.tenantId, tenantId),
            eq(quotaUsage.period, period),
            eq(quotaUsage.periodStart, periodStart)
          )
        );

      for (const record of usage) {
        const resourceType = record.resourceType;
        if (!summary[resourceType]) {
          summary[resourceType] = [];
        }
        summary[resourceType]!.push({
          period,
          usage: record.usageCount ?? 0,
          limit: record.usageLimit,
          remaining: record.usageLimit ? record.usageLimit - (record.usageCount ?? 0) : null,
        });
      }
    }

    return { quotas: summary, timestamp: now.toISOString() };
  });
}
