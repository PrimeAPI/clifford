import type { ExpectedConditions, TraceResult } from './types.js';

/**
 * Check a trace result against expected conditions.
 * Returns a list of failure messages (empty = passed).
 */
export function checkExpectations(
  expected: ExpectedConditions,
  result: {
    toolCallsMade: string[];
    outputText: string;
    iterations: number;
    completed: boolean;
    grounded: boolean;
    disambiguated: boolean;
  }
): string[] {
  const failures: string[] = [];

  // Check required tool calls
  if (expected.toolCalls) {
    for (const tool of expected.toolCalls) {
      if (!result.toolCallsMade.includes(tool)) {
        failures.push(`Expected tool call "${tool}" not found`);
      }
    }
  }

  // Check forbidden tool calls
  if (expected.forbiddenToolCalls) {
    for (const tool of expected.forbiddenToolCalls) {
      if (result.toolCallsMade.includes(tool)) {
        failures.push(`Forbidden tool call "${tool}" was made`);
      }
    }
  }

  // Check output contains
  if (expected.outputContains) {
    for (const substring of expected.outputContains) {
      if (!result.outputText.toLowerCase().includes(substring.toLowerCase())) {
        failures.push(`Output missing expected substring: "${substring}"`);
      }
    }
  }

  // Check output not contains
  if (expected.outputNotContains) {
    for (const substring of expected.outputNotContains) {
      if (result.outputText.toLowerCase().includes(substring.toLowerCase())) {
        failures.push(`Output contains forbidden substring: "${substring}"`);
      }
    }
  }

  // Check grounding
  if (expected.grounded === true && !result.grounded) {
    failures.push('Expected grounded output but no web.fetch was performed after web.search');
  }

  // Check max iterations
  if (expected.maxIterations !== undefined && result.iterations > expected.maxIterations) {
    failures.push(
      `Exceeded max iterations: ${result.iterations} > ${expected.maxIterations}`
    );
  }

  // Check completion
  if (expected.shouldComplete === true && !result.completed) {
    failures.push('Expected run to complete successfully');
  }
  if (expected.shouldComplete === false && result.completed) {
    failures.push('Expected run to fail but it completed');
  }

  // Check disambiguation
  if (expected.shouldDisambiguate === true && !result.disambiguated) {
    failures.push('Expected disambiguation but none occurred');
  }

  return failures;
}
