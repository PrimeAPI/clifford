import { describe, it, expect } from 'vitest';
import { loadGoldenTraces, generateReport, formatReport, checkExpectations } from '../src/index.js';
import { join } from 'path';

describe('eval harness', () => {
  describe('loadGoldenTraces', () => {
    it('should load traces from golden directory', () => {
      const traces = loadGoldenTraces(join(__dirname, '..', 'golden'));
      expect(traces.length).toBeGreaterThan(0);
      expect(traces[0]).toHaveProperty('name');
      expect(traces[0]).toHaveProperty('input');
      expect(traces[0]).toHaveProperty('expected');
    });

    it('should load all 5 web-grounding traces', () => {
      const traces = loadGoldenTraces(join(__dirname, '..', 'golden'));
      const names = traces.map((t) => t.name);
      expect(names).toContain('imdb-rating-grounded');
      expect(names).toContain('average-rating-uses-compute');
      expect(names).toContain('disambiguation-clifford-series');
      expect(names).toContain('simple-math-no-mental');
      expect(names).toContain('memory-not-injected-web-qa');
    });
  });

  describe('checkExpectations', () => {
    it('should pass when all conditions are met', () => {
      const failures = checkExpectations(
        { toolCalls: ['web.search'], shouldComplete: true },
        {
          toolCallsMade: ['web.search', 'web.fetch'],
          outputText: 'The rating is 9.0',
          iterations: 3,
          completed: true,
          grounded: true,
          disambiguated: false,
        }
      );
      expect(failures).toEqual([]);
    });

    it('should report missing tool calls', () => {
      const failures = checkExpectations(
        { toolCalls: ['web.search', 'compute.average'] },
        {
          toolCallsMade: ['web.search'],
          outputText: 'result',
          iterations: 2,
          completed: true,
          grounded: false,
          disambiguated: false,
        }
      );
      expect(failures).toContain('Expected tool call "compute.average" not found');
    });

    it('should report forbidden tool calls', () => {
      const failures = checkExpectations(
        { forbiddenToolCalls: ['memory.put'] },
        {
          toolCallsMade: ['web.search', 'memory.put'],
          outputText: 'result',
          iterations: 2,
          completed: true,
          grounded: false,
          disambiguated: false,
        }
      );
      expect(failures).toContain('Forbidden tool call "memory.put" was made');
    });

    it('should check output contains', () => {
      const failures = checkExpectations(
        { outputContains: ['9.0', 'IMDb'] },
        {
          toolCallsMade: [],
          outputText: 'The IMDb rating is 9.0/10',
          iterations: 1,
          completed: true,
          grounded: false,
          disambiguated: false,
        }
      );
      expect(failures).toEqual([]);
    });

    it('should report missing output substrings', () => {
      const failures = checkExpectations(
        { outputContains: ['9.0'] },
        {
          toolCallsMade: [],
          outputText: 'The rating is good',
          iterations: 1,
          completed: true,
          grounded: false,
          disambiguated: false,
        }
      );
      expect(failures.length).toBe(1);
      expect(failures[0]).toContain('9.0');
    });

    it('should check max iterations', () => {
      const failures = checkExpectations(
        { maxIterations: 5 },
        {
          toolCallsMade: [],
          outputText: 'result',
          iterations: 8,
          completed: true,
          grounded: false,
          disambiguated: false,
        }
      );
      expect(failures).toContain('Exceeded max iterations: 8 > 5');
    });

    it('should check grounding', () => {
      const failures = checkExpectations(
        { grounded: true },
        {
          toolCallsMade: ['web.search'],
          outputText: 'result',
          iterations: 2,
          completed: true,
          grounded: false,
          disambiguated: false,
        }
      );
      expect(failures.length).toBe(1);
      expect(failures[0]).toContain('grounded');
    });

    it('should check disambiguation', () => {
      const failures = checkExpectations(
        { shouldDisambiguate: true },
        {
          toolCallsMade: ['web.search'],
          outputText: 'result',
          iterations: 2,
          completed: true,
          grounded: false,
          disambiguated: false,
        }
      );
      expect(failures.length).toBe(1);
      expect(failures[0]).toContain('disambiguation');
    });
  });

  describe('generateReport', () => {
    it('should generate a correct report', () => {
      const report = generateReport([
        {
          name: 'test-1',
          passed: true,
          failures: [],
          iterations: 3,
          toolCallsMade: ['web.search'],
          outputText: 'result',
          durationMs: 100,
        },
        {
          name: 'test-2',
          passed: false,
          failures: ['Missing tool call'],
          iterations: 5,
          toolCallsMade: [],
          outputText: '',
          durationMs: 200,
        },
      ]);
      expect(report.totalTraces).toBe(2);
      expect(report.passed).toBe(1);
      expect(report.failed).toBe(1);
    });
  });

  describe('formatReport', () => {
    it('should format a report as a readable string', () => {
      const report = generateReport([
        {
          name: 'test-pass',
          passed: true,
          failures: [],
          iterations: 3,
          toolCallsMade: ['web.search'],
          outputText: 'result',
          durationMs: 100,
        },
        {
          name: 'test-fail',
          passed: false,
          failures: ['Expected tool call "compute.average" not found'],
          iterations: 5,
          toolCallsMade: [],
          outputText: '',
          durationMs: 200,
        },
      ]);
      const text = formatReport(report);
      expect(text).toContain('[PASS] test-pass');
      expect(text).toContain('[FAIL] test-fail');
      expect(text).toContain('compute.average');
    });
  });
});
