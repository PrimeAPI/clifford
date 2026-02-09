/**
 * Run metrics collector for observability and SLO tracking.
 * Collects per-run metrics that can be aggregated for dashboards and alerts.
 */

export interface RunMetrics {
  runId: string;
  tenantId: string;
  agentId: string;
  runKind: string;
  /** Total iterations in the run */
  iterations: number;
  /** Total tool calls made */
  toolCalls: number;
  /** Tool calls that failed */
  toolFailures: number;
  /** Times the LLM output failed parsing */
  parseFailures: number;
  /** Times canonicalization was applied */
  canonicalizations: number;
  /** Times local repair was applied */
  repairs: number;
  /** Times grounding nudge was triggered */
  groundingNudges: number;
  /** Whether the run completed successfully */
  completed: boolean;
  /** Duration in milliseconds */
  durationMs: number;
  /** Estimated tokens used */
  tokensUsed: number;
  /** Final run status */
  status: string;
}

/**
 * Tracks metrics for a single run. Call methods during the run,
 * then call `toMetrics()` to get the final snapshot.
 */
export class RunMetricsCollector {
  private _runId: string;
  private _tenantId: string;
  private _agentId: string;
  private _runKind: string;
  private _startTime: number;
  private _iterations = 0;
  private _toolCalls = 0;
  private _toolFailures = 0;
  private _parseFailures = 0;
  private _canonicalizations = 0;
  private _repairs = 0;
  private _groundingNudges = 0;
  private _completed = false;
  private _tokensUsed = 0;
  private _status = 'unknown';

  constructor(runId: string, tenantId: string, agentId: string, runKind: string) {
    this._runId = runId;
    this._tenantId = tenantId;
    this._agentId = agentId;
    this._runKind = runKind;
    this._startTime = Date.now();
  }

  recordIteration(): void {
    this._iterations++;
  }

  recordToolCall(success: boolean): void {
    this._toolCalls++;
    if (!success) this._toolFailures++;
  }

  recordParseFailure(): void {
    this._parseFailures++;
  }

  recordCanonicalization(): void {
    this._canonicalizations++;
  }

  recordRepair(): void {
    this._repairs++;
  }

  recordGroundingNudge(): void {
    this._groundingNudges++;
  }

  setTokensUsed(tokens: number): void {
    this._tokensUsed = tokens;
  }

  finish(status: string): void {
    this._completed = status === 'completed';
    this._status = status;
  }

  toMetrics(): RunMetrics {
    return {
      runId: this._runId,
      tenantId: this._tenantId,
      agentId: this._agentId,
      runKind: this._runKind,
      iterations: this._iterations,
      toolCalls: this._toolCalls,
      toolFailures: this._toolFailures,
      parseFailures: this._parseFailures,
      canonicalizations: this._canonicalizations,
      repairs: this._repairs,
      groundingNudges: this._groundingNudges,
      completed: this._completed,
      durationMs: Date.now() - this._startTime,
      tokensUsed: this._tokensUsed,
      status: this._status,
    };
  }
}

/**
 * SLO definitions. Each SLO has a name, threshold, and description.
 */
export const SLO_DEFINITIONS = [
  {
    name: 'tool_call_failure_rate',
    threshold: 0.05,
    description: 'Tool call failure rate should be below 5%',
    evaluate: (m: RunMetrics) =>
      m.toolCalls > 0 ? m.toolFailures / m.toolCalls < 0.05 : true,
  },
  {
    name: 'parse_failure_rate',
    threshold: 0.005,
    description: 'Command parse failure rate should be below 0.5%',
    evaluate: (m: RunMetrics) =>
      m.iterations > 0 ? m.parseFailures / m.iterations < 0.005 : true,
  },
  {
    name: 'run_completion_rate',
    threshold: 0.95,
    description: '95% of runs should complete successfully',
    evaluate: (m: RunMetrics) => m.completed,
  },
  {
    name: 'max_iterations_simple_qa',
    threshold: 8,
    description: 'Simple web Q&A should complete in under 8 iterations',
    evaluate: (m: RunMetrics) =>
      m.runKind !== 'coordinator' || m.iterations <= 8,
  },
] as const;

/**
 * Check SLOs for a completed run and return violations.
 */
export function checkSLOs(metrics: RunMetrics): string[] {
  const violations: string[] = [];
  for (const slo of SLO_DEFINITIONS) {
    if (!slo.evaluate(metrics)) {
      violations.push(slo.name);
    }
  }
  return violations;
}
