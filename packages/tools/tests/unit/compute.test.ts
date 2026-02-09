import { describe, it, expect, beforeEach } from 'vitest';
import { computeTool } from '../../src/compute.js';
import { createMockContext } from '../test-utils.js';
import type { ToolContext } from '@clifford/sdk';

describe('compute tool [unit]', () => {
  let ctx: ToolContext;

  beforeEach(() => {
    ctx = createMockContext();
  });

  describe('metadata', () => {
    it('should have correct name', () => {
      expect(computeTool.name).toBe('compute');
    });

    it('should have 8 commands', () => {
      expect(computeTool.commands).toHaveLength(8);
    });

    it('all commands should be READ classification', () => {
      for (const cmd of computeTool.commands) {
        expect(cmd.classification).toBe('READ');
      }
    });
  });

  describe('compute.average', () => {
    const cmd = computeTool.commands.find((c) => c.name === 'average')!;

    it('should calculate average of values', async () => {
      const result = (await cmd.handler(ctx, { values: [8.5, 7.2, 6.9] })) as any;
      expect(result.success).toBe(true);
      expect(result.average).toBeCloseTo(7.533, 2);
      expect(result.count).toBe(3);
    });

    it('should handle single value', async () => {
      const result = (await cmd.handler(ctx, { values: [5] })) as any;
      expect(result.success).toBe(true);
      expect(result.average).toBe(5);
      expect(result.count).toBe(1);
    });

    it('should reject empty array', async () => {
      await expect(cmd.handler(ctx, { values: [] })).rejects.toThrow();
    });

    it('should reject missing values', async () => {
      await expect(cmd.handler(ctx, {})).rejects.toThrow();
    });
  });

  describe('compute.sum', () => {
    const cmd = computeTool.commands.find((c) => c.name === 'sum')!;

    it('should calculate sum', async () => {
      const result = (await cmd.handler(ctx, { values: [1, 2, 3, 4] })) as any;
      expect(result.success).toBe(true);
      expect(result.sum).toBe(10);
      expect(result.count).toBe(4);
    });

    it('should handle negative numbers', async () => {
      const result = (await cmd.handler(ctx, { values: [-1, 2, -3] })) as any;
      expect(result.success).toBe(true);
      expect(result.sum).toBe(-2);
    });
  });

  describe('compute.min', () => {
    const cmd = computeTool.commands.find((c) => c.name === 'min')!;

    it('should find minimum', async () => {
      const result = (await cmd.handler(ctx, { values: [3, 1, 4, 1, 5] })) as any;
      expect(result.success).toBe(true);
      expect(result.result).toBe(1);
      expect(result.index).toBe(1);
    });

    it('should handle single value', async () => {
      const result = (await cmd.handler(ctx, { values: [42] })) as any;
      expect(result.success).toBe(true);
      expect(result.result).toBe(42);
      expect(result.index).toBe(0);
    });
  });

  describe('compute.max', () => {
    const cmd = computeTool.commands.find((c) => c.name === 'max')!;

    it('should find maximum', async () => {
      const result = (await cmd.handler(ctx, { values: [3, 1, 4, 1, 5] })) as any;
      expect(result.success).toBe(true);
      expect(result.result).toBe(5);
      expect(result.index).toBe(4);
    });
  });

  describe('compute.median', () => {
    const cmd = computeTool.commands.find((c) => c.name === 'median')!;

    it('should calculate median for odd count', async () => {
      const result = (await cmd.handler(ctx, { values: [3, 1, 2] })) as any;
      expect(result.success).toBe(true);
      expect(result.median).toBe(2);
    });

    it('should calculate median for even count', async () => {
      const result = (await cmd.handler(ctx, { values: [1, 2, 3, 4] })) as any;
      expect(result.success).toBe(true);
      expect(result.median).toBe(2.5);
    });

    it('should handle single value', async () => {
      const result = (await cmd.handler(ctx, { values: [7] })) as any;
      expect(result.success).toBe(true);
      expect(result.median).toBe(7);
    });
  });

  describe('compute.round', () => {
    const cmd = computeTool.commands.find((c) => c.name === 'round')!;

    it('should round to 2 decimal places by default', async () => {
      const result = (await cmd.handler(ctx, { value: 3.14159 })) as any;
      expect(result.success).toBe(true);
      expect(result.result).toBe(3.14);
    });

    it('should round to specified decimal places', async () => {
      const result = (await cmd.handler(ctx, { value: 3.14159, decimals: 4 })) as any;
      expect(result.success).toBe(true);
      expect(result.result).toBe(3.1416);
    });

    it('should round to 0 decimal places', async () => {
      const result = (await cmd.handler(ctx, { value: 3.7, decimals: 0 })) as any;
      expect(result.success).toBe(true);
      expect(result.result).toBe(4);
    });
  });

  describe('compute.percentage', () => {
    const cmd = computeTool.commands.find((c) => c.name === 'percentage')!;

    it('should calculate percentage', async () => {
      const result = (await cmd.handler(ctx, { value: 75, total: 200 })) as any;
      expect(result.success).toBe(true);
      expect(result.percentage).toBe(37.5);
    });

    it('should handle zero total', async () => {
      const result = (await cmd.handler(ctx, { value: 5, total: 0 })) as any;
      expect(result.success).toBe(false);
      expect(result.error).toContain('zero');
    });

    it('should handle 100%', async () => {
      const result = (await cmd.handler(ctx, { value: 50, total: 50 })) as any;
      expect(result.success).toBe(true);
      expect(result.percentage).toBe(100);
    });
  });

  describe('compute.eval', () => {
    const cmd = computeTool.commands.find((c) => c.name === 'eval')!;

    it('should evaluate simple addition', async () => {
      const result = (await cmd.handler(ctx, { expression: '1 + 2' })) as any;
      expect(result.success).toBe(true);
      expect(result.result).toBe(3);
    });

    it('should evaluate complex expression', async () => {
      const result = (await cmd.handler(ctx, {
        expression: '(8.5 + 7.2 + 6.9) / 3',
      })) as any;
      expect(result.success).toBe(true);
      expect(result.result).toBeCloseTo(7.533, 2);
    });

    it('should respect operator precedence', async () => {
      const result = (await cmd.handler(ctx, { expression: '2 + 3 * 4' })) as any;
      expect(result.success).toBe(true);
      expect(result.result).toBe(14);
    });

    it('should handle parentheses', async () => {
      const result = (await cmd.handler(ctx, { expression: '(2 + 3) * 4' })) as any;
      expect(result.success).toBe(true);
      expect(result.result).toBe(20);
    });

    it('should handle negative numbers', async () => {
      const result = (await cmd.handler(ctx, { expression: '-3 + 5' })) as any;
      expect(result.success).toBe(true);
      expect(result.result).toBe(2);
    });

    it('should handle modulo', async () => {
      const result = (await cmd.handler(ctx, { expression: '10 % 3' })) as any;
      expect(result.success).toBe(true);
      expect(result.result).toBe(1);
    });

    it('should return error for division by zero', async () => {
      const result = (await cmd.handler(ctx, { expression: '5 / 0' })) as any;
      expect(result.success).toBe(false);
      expect(result.error).toContain('Division by zero');
    });

    it('should return error for invalid expression', async () => {
      const result = (await cmd.handler(ctx, { expression: 'abc' })) as any;
      expect(result.success).toBe(false);
    });

    it('should reject empty expression', async () => {
      await expect(cmd.handler(ctx, { expression: '' })).rejects.toThrow();
    });

    it('should handle decimal numbers', async () => {
      const result = (await cmd.handler(ctx, { expression: '0.1 + 0.2' })) as any;
      expect(result.success).toBe(true);
      expect(result.result).toBeCloseTo(0.3, 10);
    });

    it('should handle nested parentheses', async () => {
      const result = (await cmd.handler(ctx, { expression: '((2 + 3) * (4 - 1))' })) as any;
      expect(result.success).toBe(true);
      expect(result.result).toBe(15);
    });
  });
});
