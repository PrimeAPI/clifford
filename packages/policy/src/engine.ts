import type { PolicyDecision, PolicyContext, ToolDef } from '@clifford/sdk';
import {
  getDb,
  policyRules,
  quotaUsage,
  getPeriodStart,
  type PolicyRule,
  type PolicyConditions,
  type PolicyConfig,
  type PolicyAction,
  type ResourceType,
  type QuotaPeriod,
} from '@clifford/db';
import { eq, and, desc, sql } from 'drizzle-orm';

export interface PolicyEngineOptions {
  profile?: string;
  db?: ReturnType<typeof getDb>;
}

export interface PolicyDecisionResult {
  decision: PolicyDecision;
  reason?: string;
  ruleId?: string;
  ruleName?: string;
}

export class PolicyEngine {
  private _profile: string;
  private _db?: ReturnType<typeof getDb>;

  constructor(options: PolicyEngineOptions = {}) {
    this._profile = options.profile || 'default';
    this._db = options.db;
  }

  private get db(): ReturnType<typeof getDb> {
    return this._db ?? getDb();
  }

  /**
   * Load applicable policy rules for a tenant/agent, ordered by priority.
   */
  async loadRules(tenantId: string, agentId?: string): Promise<PolicyRule[]> {
    const conditions = agentId
      ? and(
          eq(policyRules.tenantId, tenantId),
          eq(policyRules.enabled, true),
          sql`(${policyRules.agentId} IS NULL OR ${policyRules.agentId} = ${agentId})`
        )
      : and(
          eq(policyRules.tenantId, tenantId),
          eq(policyRules.enabled, true),
          sql`${policyRules.agentId} IS NULL`
        );

    const rules = await this.db
      .select()
      .from(policyRules)
      .where(conditions)
      .orderBy(desc(policyRules.priority));

    return rules;
  }

  /**
   * Check if a rule's conditions match the current context.
   */
  matchesConditions(
    rule: PolicyRule,
    ctx: PolicyContext,
    toolDef: ToolDef
  ): boolean {
    const conditions = rule.conditions as PolicyConditions;

    // Check tool pattern
    if (conditions.tool) {
      const pattern = conditions.tool;
      if (pattern.endsWith('.*')) {
        const prefix = pattern.slice(0, -2);
        if (!ctx.toolName.startsWith(prefix)) return false;
      } else if (pattern !== ctx.toolName) {
        return false;
      }
    }

    // Check command pattern
    if (conditions.command) {
      const fullCommand = `${ctx.toolName}.${ctx.commandName}`;
      if (conditions.command !== fullCommand) return false;
    }

    // Check classification
    if (conditions.classification) {
      const command = toolDef.commands.find((c) => c.name === ctx.commandName);
      if (!command || command.classification !== conditions.classification) {
        return false;
      }
    }

    // Check args pattern (simple equality check)
    if (conditions.argsPattern) {
      for (const [key, expectedValue] of Object.entries(conditions.argsPattern)) {
        if (ctx.args[key] !== expectedValue) {
          return false;
        }
      }
    }

    // Check runKind (coordinator, subagent, etc.)
    if (conditions.runKind && conditions.runKind !== ctx.runKind) {
      return false;
    }

    return true;
  }

  /**
   * Apply a rule and return the decision.
   */
  applyRule(rule: PolicyRule): PolicyDecisionResult {
    const action = rule.action as PolicyAction;
    const config = rule.config as PolicyConfig | null;

    switch (action) {
      case 'allow':
        return { decision: 'allow', ruleId: rule.id, ruleName: rule.name };
      case 'deny':
        return {
          decision: 'deny',
          reason: config?.message ?? `Denied by policy: ${rule.name}`,
          ruleId: rule.id,
          ruleName: rule.name,
        };
      case 'confirm':
        return {
          decision: 'confirm',
          reason: config?.message ?? `Requires confirmation: ${rule.name}`,
          ruleId: rule.id,
          ruleName: rule.name,
        };
      case 'rate_limit':
        // Rate limiting is handled separately via checkQuotas
        return { decision: 'allow', ruleId: rule.id, ruleName: rule.name };
      default:
        return { decision: 'confirm', ruleId: rule.id, ruleName: rule.name };
    }
  }

  /**
   * Get the default decision based on command classification.
   */
  classificationDefault(toolDef: ToolDef, commandName: string): PolicyDecisionResult {
    const command = toolDef.commands.find((c) => c.name === commandName);
    if (!command) {
      return { decision: 'confirm', reason: 'Unknown command' };
    }

    switch (command.classification) {
      case 'READ':
        return { decision: 'allow', reason: 'Classification: READ' };
      case 'WRITE':
        return { decision: 'confirm', reason: 'Classification: WRITE' };
      case 'DESTRUCT':
        return { decision: 'deny', reason: 'Classification: DESTRUCT' };
      case 'SENSITIVE':
        return { decision: 'confirm', reason: 'Classification: SENSITIVE' };
      default:
        return { decision: 'confirm', reason: 'Unknown classification' };
    }
  }

  /**
   * Check quota constraints.
   */
  async checkQuotas(
    ctx: PolicyContext,
    resourceType: ResourceType = 'tool_calls'
  ): Promise<{ allowed: boolean; reason?: string }> {
    const periods: QuotaPeriod[] = ['hourly', 'daily', 'monthly'];

    for (const period of periods) {
      const periodStart = getPeriodStart(period);

      const [usage] = await this.db
        .select()
        .from(quotaUsage)
        .where(
          and(
            eq(quotaUsage.tenantId, ctx.tenantId),
            eq(quotaUsage.resourceType, resourceType),
            eq(quotaUsage.period, period),
            eq(quotaUsage.periodStart, periodStart)
          )
        )
        .limit(1);

      const usageCount = usage?.usageCount ?? 0;
      if (usage && usage.usageLimit !== null && usageCount >= usage.usageLimit) {
        return {
          allowed: false,
          reason: `${period} ${resourceType} quota exceeded (${usageCount}/${usage.usageLimit})`,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Record usage for quota tracking.
   */
  async recordUsage(
    ctx: PolicyContext,
    usage: { tokens?: number; toolCalls?: number; embeddingTokens?: number }
  ): Promise<void> {
    const now = new Date();
    const updates: Array<{ resourceType: ResourceType; amount: number }> = [];

    if (usage.tokens) updates.push({ resourceType: 'tokens', amount: usage.tokens });
    if (usage.toolCalls) updates.push({ resourceType: 'tool_calls', amount: usage.toolCalls });
    if (usage.embeddingTokens)
      updates.push({ resourceType: 'embedding_tokens', amount: usage.embeddingTokens });

    for (const update of updates) {
      for (const period of ['hourly', 'daily', 'monthly'] as QuotaPeriod[]) {
        const periodStart = getPeriodStart(period, now);

        // Upsert the quota usage record
        await this.db.execute(sql`
          INSERT INTO quota_usage (tenant_id, agent_id, resource_type, period, period_start, usage_count, updated_at)
          VALUES (${ctx.tenantId}, ${ctx.agentId}, ${update.resourceType}, ${period}, ${periodStart}, ${update.amount}, NOW())
          ON CONFLICT (tenant_id, COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'), COALESCE(user_id, '00000000-0000-0000-0000-000000000000'), resource_type, period, period_start)
          DO UPDATE SET usage_count = quota_usage.usage_count + ${update.amount}, updated_at = NOW()
        `);
      }
    }
  }

  /**
   * Main entry point: decide if a tool call should be allowed.
   */
  async decideToolCall(
    ctx: PolicyContext,
    toolDef: ToolDef,
    budgetState?: BudgetState
  ): Promise<PolicyDecision> {
    const result = await this.decideToolCallWithDetails(ctx, toolDef, budgetState);
    return result.decision;
  }

  /**
   * Decide with full details about which rule matched.
   */
  async decideToolCallWithDetails(
    ctx: PolicyContext,
    toolDef: ToolDef,
    budgetState?: BudgetState
  ): Promise<PolicyDecisionResult> {
    // 1. Check budget constraints first
    if (budgetState) {
      const budgetOk = await this.checkBudget(ctx, budgetState);
      if (!budgetOk) {
        return { decision: 'confirm', reason: 'Budget exceeded' };
      }
    }

    // 2. Check quotas
    const quotaCheck = await this.checkQuotas(ctx);
    if (!quotaCheck.allowed) {
      return { decision: 'deny', reason: quotaCheck.reason };
    }

    // 3. Load and evaluate policy rules
    const rules = await this.loadRules(ctx.tenantId, ctx.agentId);

    for (const rule of rules) {
      if (this.matchesConditions(rule, ctx, toolDef)) {
        return this.applyRule(rule);
      }
    }

    // 4. Fall back to classification-based default
    return this.classificationDefault(toolDef, ctx.commandName);
  }

  /**
   * Check budget constraints (tokens, time).
   */
  async checkBudget(_ctx: PolicyContext, budgetState: BudgetState): Promise<boolean> {
    const withinTokens = budgetState.tokensUsed <= budgetState.tokensLimit;
    const withinTime = budgetState.timeUsedMs <= budgetState.timeLimitMs;
    return withinTokens && withinTime;
  }
}

// Budget tracking
export interface BudgetState {
  tokensUsed: number;
  tokensLimit: number;
  timeUsedMs: number;
  timeLimitMs: number;
}

export function createBudgetState(
  overrides?: Partial<Pick<BudgetState, 'tokensLimit' | 'timeLimitMs'>>
): BudgetState {
  return {
    tokensUsed: 0,
    tokensLimit: overrides?.tokensLimit ?? 1_000_000,
    timeUsedMs: 0,
    timeLimitMs: overrides?.timeLimitMs ?? 3600_000, // 1 hour
  };
}
