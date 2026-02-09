import { describe, it, expect } from 'vitest';
import { canonicalize, repair } from '../../src/action-canonicalizer.js';
import { commandSchema } from '@clifford/sdk';

describe('canonicalize', () => {
  it('passes through valid tool_call unchanged', () => {
    const input = { type: 'tool_call', name: 'web.search', args: { query: 'test' } };
    const result = canonicalize(input);
    expect(result).toEqual(input);
  });

  it('passes through valid send_message unchanged', () => {
    const input = { type: 'send_message', message: 'hello' };
    const result = canonicalize(input);
    expect(result).toEqual(input);
  });

  it('passes through valid finish unchanged', () => {
    const input = { type: 'finish', output: 'done' };
    const result = canonicalize(input);
    expect(result).toEqual(input);
  });

  describe('shorthand tool call', () => {
    it('converts {type: "web.search", args: {query: "x"}} to tool_call', () => {
      const input = { type: 'web.search', args: { query: 'test' } };
      const result = canonicalize(input);
      expect(result).toEqual({
        type: 'tool_call',
        name: 'web.search',
        args: { query: 'test' },
      });
    });

    it('converts {type: "memory.get", args: {key: "k"}} to tool_call', () => {
      const input = { type: 'memory.get', args: { key: 'k' } };
      const result = canonicalize(input);
      expect(result).toEqual({
        type: 'tool_call',
        name: 'memory.get',
        args: { key: 'k' },
      });
    });

    it('wraps top-level keys as args when no args field present', () => {
      const input = { type: 'web.search', query: 'test', limit: 5 };
      const result = canonicalize(input);
      expect(result).toEqual({
        type: 'tool_call',
        name: 'web.search',
        args: { query: 'test', limit: 5 },
      });
    });
  });

  describe('name-based tool call', () => {
    it('converts {name: "web.search", args: {...}} to tool_call', () => {
      const input = { name: 'web.search', args: { query: 'test' } };
      const result = canonicalize(input);
      expect(result).toEqual({
        type: 'tool_call',
        name: 'web.search',
        args: { query: 'test' },
      });
    });

    it('uses empty args when none provided', () => {
      const input = { name: 'system.ping' };
      const result = canonicalize(input);
      expect(result).toEqual({
        type: 'tool_call',
        name: 'system.ping',
        args: {},
      });
    });
  });

  describe('top-level arg flattening', () => {
    it('wraps extra keys into args for tool_call', () => {
      const input = { type: 'tool_call', name: 'web.search', query: 'test' };
      const result = canonicalize(input);
      expect(result).toEqual({
        type: 'tool_call',
        name: 'web.search',
        args: { query: 'test' },
      });
    });

    it('does not flatten when args already present', () => {
      const input = { type: 'tool_call', name: 'web.search', args: { query: 'test' }, extra: 'x' };
      const result = canonicalize(input);
      // args is present, so no flattening
      expect(result).toEqual(input);
    });
  });

  describe('type aliases', () => {
    it('converts "message" to "send_message"', () => {
      const input = { type: 'message', message: 'hello' };
      const result = canonicalize(input);
      expect(result.type).toBe('send_message');
    });

    it('converts "msg" to "send_message"', () => {
      const input = { type: 'msg', message: 'hello' };
      const result = canonicalize(input);
      expect(result.type).toBe('send_message');
    });

    it('converts "done" to "finish"', () => {
      const input = { type: 'done', output: 'result' };
      const result = canonicalize(input);
      expect(result.type).toBe('finish');
    });
  });

  describe('content → message for send_message', () => {
    it('renames content to message', () => {
      const input = { type: 'send_message', content: 'hello' };
      const result = canonicalize(input);
      expect(result).toEqual({ type: 'send_message', message: 'hello' });
    });

    it('does not rename when message already exists', () => {
      const input = { type: 'send_message', message: 'hello', content: 'world' };
      const result = canonicalize(input);
      expect(result.message).toBe('hello');
    });
  });

  describe('implicit finish', () => {
    it('converts {output: "...", done: true} to finish', () => {
      const input = { output: 'result', done: true };
      const result = canonicalize(input);
      expect(result).toEqual({ type: 'finish', output: 'result' });
    });

    it('converts {output: "...", finished: true} to finish', () => {
      const input = { output: 'result', finished: true };
      const result = canonicalize(input);
      expect(result).toEqual({ type: 'finish', output: 'result' });
    });
  });

  describe('canonicalized output validates with Zod', () => {
    it('shorthand tool call passes validation', () => {
      const input = { type: 'web.search', args: { query: 'test' } };
      const result = canonicalize(input);
      expect(commandSchema.safeParse(result).success).toBe(true);
    });

    it('name-based tool call passes validation', () => {
      const input = { name: 'web.search', args: { query: 'test' } };
      const result = canonicalize(input);
      expect(commandSchema.safeParse(result).success).toBe(true);
    });

    it('message alias passes validation', () => {
      const input = { type: 'message', content: 'hello' };
      const result = canonicalize(input);
      expect(commandSchema.safeParse(result).success).toBe(true);
    });

    it('implicit finish passes validation', () => {
      const input = { output: 'done', done: true };
      const result = canonicalize(input);
      expect(commandSchema.safeParse(result).success).toBe(true);
    });
  });
});

describe('repair', () => {
  it('returns null when no repairs can be applied', () => {
    const input = { type: 'unknown_type', foo: 'bar' };
    const validation = commandSchema.safeParse(input);
    expect(validation.success).toBe(false);
    if (!validation.success) {
      const result = repair(input, validation.error);
      expect(result).toBeNull();
    }
  });

  it('repairs content → message for send_message', () => {
    const input = { type: 'send_message', content: 'hello' };
    const validation = commandSchema.safeParse(input);
    expect(validation.success).toBe(false);
    if (!validation.success) {
      const result = repair(input, validation.error);
      expect(result).not.toBeNull();
      expect(result!.repaired.message).toBe('hello');
      expect(result!.applied).toContain('content→message');
    }
  });

  it('repairs args as JSON string', () => {
    const input = { type: 'tool_call', name: 'web.search', args: '{"query":"test"}' };
    const validation = commandSchema.safeParse(input);
    expect(validation.success).toBe(false);
    if (!validation.success) {
      const result = repair(input, validation.error);
      expect(result).not.toBeNull();
      expect(result!.repaired.args).toEqual({ query: 'test' });
      expect(result!.applied).toContain('args:string→object');
    }
  });

  it('repairs maxIterations string → number for set_run_limits', () => {
    const input = { type: 'set_run_limits', maxIterations: '25' };
    const validation = commandSchema.safeParse(input);
    expect(validation.success).toBe(false);
    if (!validation.success) {
      const result = repair(input, validation.error);
      expect(result).not.toBeNull();
      expect(result!.repaired.maxIterations).toBe(25);
      expect(result!.applied).toContain('maxIterations:string→number');
    }
  });

  it('does not repair invalid maxIterations string', () => {
    const input = { type: 'set_run_limits', maxIterations: 'many' };
    const validation = commandSchema.safeParse(input);
    expect(validation.success).toBe(false);
    if (!validation.success) {
      const result = repair(input, validation.error);
      // 'many' cannot be parsed to a positive number
      expect(result).toBeNull();
    }
  });

  it('repaired output validates with Zod', () => {
    const input = { type: 'send_message', content: 'hello' };
    const validation = commandSchema.safeParse(input);
    if (!validation.success) {
      const result = repair(input, validation.error);
      expect(result).not.toBeNull();
      const revalidation = commandSchema.safeParse(result!.repaired);
      expect(revalidation.success).toBe(true);
    }
  });
});
