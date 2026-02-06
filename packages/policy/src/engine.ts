import type { PolicyDecision, PolicyContext, ToolDef } from '@clifford/sdk';

export interface PolicyEngineOptions {
  profile?: string;
}

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
    toolDef: ToolDef,
    budgetState?: BudgetState
  ): Promise<PolicyDecision> {
    if (budgetState) {
      const budgetOk = await this.checkBudget(ctx, budgetState);
      if (!budgetOk) {
        return 'confirm';
      }
    }
    const command = toolDef.commands.find((entry) => entry.name === ctx.commandName);
    if (!command) {
      return 'confirm';
    }

    switch (command.classification) {
      case 'READ':
        return 'allow';
      case 'WRITE':
        return 'confirm';
      case 'DESTRUCT':
        return 'deny';
      case 'SENSITIVE':
        return 'confirm';
      default:
        return 'confirm';
    }
  }

  /**
   * TODO: Check budget constraints (tokens, time, cost)
   */
  async checkBudget(_ctx: PolicyContext, _budgetState: BudgetState): Promise<boolean> {
    const withinTokens = _budgetState.tokensUsed <= _budgetState.tokensLimit;
    const withinTime = _budgetState.timeUsedMs <= _budgetState.timeLimitMs;
    return withinTokens && withinTime;
  }
}

// Budget tracking (stub for MVP)
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
