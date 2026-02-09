/**
 * Unit tests for system tool
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { systemTool } from '../../src/system.js';
import { createMockContext } from '../test-utils.js';
import type { ToolContext } from '@clifford/sdk';

describe('system tool [unit]', () => {
  let ctx: ToolContext;

  beforeEach(() => {
    ctx = createMockContext();
  });

  describe('metadata', () => {
    it('should have correct name', () => {
      expect(systemTool.name).toBe('system');
    });

    it('should be pinned', () => {
      expect(systemTool.pinned).toBe(true);
    });

    it('should have commands', () => {
      expect(systemTool.commands).toHaveLength(1);
      expect(systemTool.commands[0]?.name).toBe('ping');
    });
  });

  describe('system.ping', () => {
    const pingCommand = systemTool.commands.find((c) => c.name === 'ping');

    it('should exist', () => {
      expect(pingCommand).toBeDefined();
    });

    it('should have correct classification', () => {
      expect(pingCommand?.classification).toBe('READ');
    });

    it('should return success with timestamp', async () => {
      const result = await pingCommand!.handler(ctx, {});
      
      expect(result).toHaveProperty('ok', true);
      expect(result).toHaveProperty('ts');
      expect(typeof (result as any).ts).toBe('string');
      
      // Validate ISO 8601 format
      const ts = (result as any).ts;
      expect(new Date(ts).toISOString()).toBe(ts);
    });

    it('should return error when disabled via config', async () => {
      ctx.toolConfig = { allow_ping: false };
      
      const result = await pingCommand!.handler(ctx, {});
      
      expect(result).toHaveProperty('ok', false);
      expect(result).toHaveProperty('error');
    });

    it('should accept empty args', async () => {
      const result = await pingCommand!.handler(ctx, {});
      expect(result).toHaveProperty('ok', true);
    });

    it('should validate args schema', () => {
      const schema = pingCommand!.argsSchema;
      expect(() => schema.parse({})).not.toThrow();
      // Zod doesn't reject extra fields by default in passthrough mode
    });
  });

  describe('configuration', () => {
    it('should have config schema', () => {
      expect(systemTool.config).toBeDefined();
      expect(systemTool.config?.schema).toBeDefined();
    });

    it('should have config fields', () => {
      expect(systemTool.config?.fields).toBeDefined();
      expect(systemTool.config?.fields.length).toBeGreaterThan(0);
      
      const allowPingField = systemTool.config?.fields.find((f) => f.key === 'allow_ping');
      expect(allowPingField).toBeDefined();
      expect(allowPingField?.type).toBe('boolean');
    });

    it('should validate config schema', () => {
      const schema = systemTool.config?.schema;
      expect(schema).toBeDefined();
      
      // Valid config
      expect(() => schema!.parse({ allow_ping: true })).not.toThrow();
      expect(() => schema!.parse({ max_retries: 3 })).not.toThrow();
      expect(() => schema!.parse({})).not.toThrow();
      
      // Invalid config
      expect(() => schema!.parse({ allow_ping: 'yes' })).toThrow();
      expect(() => schema!.parse({ max_retries: -1 })).toThrow();
      expect(() => schema!.parse({ max_retries: 10 })).toThrow();
    });
  });
});
