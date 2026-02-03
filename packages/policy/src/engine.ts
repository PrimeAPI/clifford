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
    _budgetState?: BudgetState
  ): Promise<PolicyDecision> {
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
