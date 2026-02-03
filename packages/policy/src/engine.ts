import type { PolicyDecision, PolicyContext, ToolDef } from '@clifford/sdk';

export interface PolicyEngineOptions {
  profile?: string;
}

// Tool categories for policy decisions
const READ_TOOLS = ['system.ping', 'memory.get'];
const WRITE_TOOLS = ['memory.put'];
const DESTRUCTIVE_TOOLS: string[] = [];

export class PolicyEngine {
  private _profile: string;

  constructor(options: PolicyEngineOptions = {}) {
    this._profile = options.profile || 'default';
  }

  /**
   * Decide if a tool call should be allowed, require confirmation, or be denied
   */
  async decideToolCall(
    ctx: PolicyContext,
    _toolDef: ToolDef,
    _budgetState?: BudgetState
  ): Promise<PolicyDecision> {
    const { toolName } = ctx;

    // Default policy logic
    if (READ_TOOLS.includes(toolName)) {
      return 'allow';
    }

    if (WRITE_TOOLS.includes(toolName)) {
      return 'confirm';
    }

    if (DESTRUCTIVE_TOOLS.includes(toolName)) {
      return 'deny';
    }

    // Default: unknown tools require confirmation
    return 'confirm';
  }

  /**
   * TODO: Check budget constraints (tokens, time, cost)
   */
  async checkBudget(_ctx: PolicyContext, _budgetState: BudgetState): Promise<boolean> {
    // Stub: always allow for MVP
    return true;
  }
}

// Budget tracking (stub for MVP)
export interface BudgetState {
  tokensUsed: number;
  tokensLimit: number;
  timeUsedMs: number;
  timeLimitMs: number;
}

export function createBudgetState(): BudgetState {
  return {
    tokensUsed: 0,
    tokensLimit: 1_000_000,
    timeUsedMs: 0,
    timeLimitMs: 3600_000, // 1 hour
  };
}
