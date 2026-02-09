/**
 * Evaluation harness runner.
 * Loads golden traces and reports results.
 *
 * Usage: npx tsx src/runner.ts [--filter <name>]
 *
 * Note: The actual run execution requires the full worker infrastructure.
 * This module provides the framework; integration with processRun is
 * done in the eval test suite or CI pipeline.
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { GoldenTrace, EvalReport, TraceResult } from './types.js';

/**
 * Load golden traces from a directory of JSON files.
 */
export function loadGoldenTraces(dir: string): GoldenTrace[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const traces: GoldenTrace[] = [];

  for (const file of files) {
    const content = readFileSync(join(dir, file), 'utf-8');
    const data = JSON.parse(content);
    if (Array.isArray(data)) {
      traces.push(...data);
    } else {
      traces.push(data);
    }
  }

  return traces;
}

/**
 * Generate an evaluation report from trace results.
 */
export function generateReport(results: TraceResult[]): EvalReport {
  return {
    timestamp: new Date().toISOString(),
    totalTraces: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    results,
  };
}

/**
 * Format a report as a human-readable string.
 */
export function formatReport(report: EvalReport): string {
  const lines: string[] = [
    `Evaluation Report - ${report.timestamp}`,
    `Total: ${report.totalTraces} | Passed: ${report.passed} | Failed: ${report.failed}`,
    '',
  ];

  for (const result of report.results) {
    const status = result.passed ? 'PASS' : 'FAIL';
    lines.push(`[${status}] ${result.name} (${result.iterations} iterations, ${result.durationMs}ms)`);
    if (!result.passed) {
      for (const failure of result.failures) {
        lines.push(`  - ${failure}`);
      }
    }
  }

  return lines.join('\n');
}

export { type GoldenTrace, type EvalReport, type TraceResult } from './types.js';
export { checkExpectations } from './assertions.js';
