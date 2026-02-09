/**
 * Golden trace definitions for the evaluation harness.
 */

export interface GoldenTrace {
  /** Unique name for this trace */
  name: string;
  /** Description of what this trace tests */
  description: string;
  /** Category for grouping */
  category: 'grounding' | 'disambiguation' | 'compute' | 'memory' | 'general';
  /** Input task text */
  input: string;
  /** Expected conditions that must be met */
  expected: ExpectedConditions;
}

export interface ExpectedConditions {
  /** Tool calls that must appear in the trace (by tool.command name) */
  toolCalls?: string[];
  /** Tool calls that must NOT appear */
  forbiddenToolCalls?: string[];
  /** Substrings that must appear in the final output */
  outputContains?: string[];
  /** Substrings that must NOT appear in the final output */
  outputNotContains?: string[];
  /** Whether the run must have grounding (web.fetch after web.search) */
  grounded?: boolean;
  /** Maximum iterations allowed */
  maxIterations?: number;
  /** Whether the run should complete successfully */
  shouldComplete?: boolean;
  /** Whether disambiguation should be triggered */
  shouldDisambiguate?: boolean;
}

export interface TraceResult {
  name: string;
  passed: boolean;
  failures: string[];
  iterations: number;
  toolCallsMade: string[];
  outputText: string;
  durationMs: number;
}

export interface EvalReport {
  timestamp: string;
  totalTraces: number;
  passed: number;
  failed: number;
  results: TraceResult[];
}
