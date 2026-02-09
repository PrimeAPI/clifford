/**
 * Unit tests for memory tool
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { memoryTool } from '../../src/memory.js';
import { createMockContext, createMockDb } from '../test-utils.js';
import type { ToolContext } from '@clifford/sdk';

describe('memory tool [unit]', () => {
  let ctx: ToolContext;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
    ctx = createMockContext({ db: mockDb });
  });

  describe('metadata', () => {
    it('should have correct name', () => {
      expect(memoryTool.name).toBe('memory');
    });

    it('should be pinned', () => {
      expect(memoryTool.pinned).toBe(true);
    });

    it('should have all commands', () => {
      const commandNames = memoryTool.commands.map((c) => c.name);
      expect(commandNames).toContain('get');
      expect(commandNames).toContain('put');
      expect(commandNames).toContain('search');
      expect(commandNames).toContain('sessions');
      expect(commandNames).toContain('session_messages');
    });
  });

  describe('memory.get', () => {
    const getCommand = memoryTool.commands.find((c) => c.name === 'get');

    it('should return success when key exists', async () => {
      mockDb.limit.mockResolvedValue([{ key: 'test_key', value: 'test_value' }]);

      const result = await getCommand!.handler(ctx, { key: 'test_key' });

      expect(result).toEqual({
        success: true,
        key: 'test_key',
        value: 'test_value',
      });
    });

    it('should return error when key not found', async () => {
      mockDb.limit.mockResolvedValue([]);

      const result = await getCommand!.handler(ctx, { key: 'missing_key' });

      expect(result).toEqual({
        success: false,
        error: 'Key not found',
      });
    });

    it('should validate key length', () => {
      const schema = getCommand!.argsSchema;
      
      // Valid keys
      expect(() => schema.parse({ key: 'a' })).not.toThrow();
      expect(() => schema.parse({ key: 'a'.repeat(255) })).not.toThrow();
      
      // Invalid keys
      expect(() => schema.parse({ key: '' })).toThrow(); // Too short
      expect(() => schema.parse({ key: 'a'.repeat(256) })).toThrow(); // Too long
    });

    it('should log retrieval', async () => {
      mockDb.limit.mockResolvedValue([{ key: 'test_key', value: 'test_value' }]);

      await getCommand!.handler(ctx, { key: 'test_key' });

      expect(ctx.logger.info).toHaveBeenCalledWith('Memory retrieved', { key: 'test_key' });
    });
  });

  describe('memory.put', () => {
    const putCommand = memoryTool.commands.find((c) => c.name === 'put');

    it('should store key-value pair', async () => {
      mockDb.onConflictDoUpdate.mockResolvedValue(undefined);

      const result = await putCommand!.handler(ctx, {
        key: 'user_timezone',
        value: 'America/New_York',
      });

      expect(result).toEqual({
        success: true,
        key: 'user_timezone',
      });
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it('should validate key and value lengths', () => {
      const schema = putCommand!.argsSchema;

      // Valid
      expect(() => schema.parse({ key: 'k', value: 'v' })).not.toThrow();
      expect(() => schema.parse({ key: 'a'.repeat(255), value: 'b'.repeat(10000) })).not.toThrow();

      // Invalid key
      expect(() => schema.parse({ key: '', value: 'v' })).toThrow();
      expect(() => schema.parse({ key: 'a'.repeat(256), value: 'v' })).toThrow();

      // Invalid value
      expect(() => schema.parse({ key: 'k', value: 'a'.repeat(10001) })).toThrow();
    });

    it('should log storage', async () => {
      mockDb.onConflictDoUpdate.mockResolvedValue(undefined);

      await putCommand!.handler(ctx, { key: 'test', value: 'value' });

      expect(ctx.logger.info).toHaveBeenCalledWith('Memory stored', { key: 'test' });
    });

    it('should have WRITE classification', () => {
      expect(putCommand!.classification).toBe('WRITE');
    });
  });

  describe('memory.search', () => {
    const searchCommand = memoryTool.commands.find((c) => c.name === 'search');

    it('should return error without userId', async () => {
      ctx.userId = undefined;

      const result = await searchCommand!.handler(ctx, { query: 'test' });

      expect(result).toEqual({
        success: false,
        error: 'User context unavailable',
      });
    });

    it('should search and return results', async () => {
      // Mock the main search query (line 201-206 in memory.ts)
      const searchResults = [
        {
          id: '1',
          level: 0,
          module: 'test',
          key: 'test_key',
          value: 'test_value',
          confidence: 0.9,
          lastSeenAt: new Date(),
        },
      ];
      
      // Mock loadActiveMemoryIds query (line 298-301 in memory.ts)
      const activeMemoryResults: any[] = [];
      
      // Need to handle both query patterns:
      // Pattern 1: .select().from().where().orderBy().limit() -> searchResults
      // Pattern 2: .select().from().where() -> activeMemoryResults (awaited directly)
      
      // Reset the where mock to handle both cases
      let whereCallCount = 0;
      const originalWhereMock = mockDb.where;
      mockDb.where = vi.fn().mockImplementation((...args) => {
        whereCallCount++;
        if (whereCallCount === 1) {
          // First where() is part of search query - return mockDb for chaining
          return mockDb;
        } else {
          // Second where() is loadActiveMemoryIds - return promise directly
          return Promise.resolve(activeMemoryResults);
        }
      });
      
      mockDb.limit.mockResolvedValue(searchResults);

      const result = await searchCommand!.handler(ctx, { query: 'test', limit: 10 });

      // Restore original mock
      mockDb.where = originalWhereMock;

      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('total', 1);
      expect(result).toHaveProperty('memories');
    });

    it('should validate query and limit', () => {
      const schema = searchCommand!.argsSchema;

      // Valid
      expect(() => schema.parse({ query: 'test' })).not.toThrow();
      expect(() => schema.parse({ query: 'a'.repeat(200), limit: 50 })).not.toThrow();

      // Invalid query
      expect(() => schema.parse({ query: '' })).toThrow();
      expect(() => schema.parse({ query: 'a'.repeat(201) })).toThrow();

      // Invalid limit
      expect(() => schema.parse({ query: 'test', limit: 0 })).toThrow();
      expect(() => schema.parse({ query: 'test', limit: 51 })).toThrow();
    });
  });

  describe('memory.sessions', () => {
    const sessionsCommand = memoryTool.commands.find((c) => c.name === 'sessions');

    it('should return error without userId', async () => {
      ctx.userId = undefined;

      const result = await sessionsCommand!.handler(ctx, {});

      expect(result).toEqual({
        success: false,
        error: 'User context unavailable',
      });
    });

    it('should return sessions list', async () => {
      mockDb.limit.mockResolvedValue([
        {
          id: 'ctx-1',
          name: 'Session 1',
          channelId: 'ch-1',
          createdAt: new Date(),
          updatedAt: new Date(),
          closedAt: null,
          turnCount: 5,
        },
      ]);

      const result = await sessionsCommand!.handler(ctx, { limit: 10 });

      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('sessions');
      expect((result as any).sessions).toHaveLength(1);
    });
  });

  describe('memory.session_messages', () => {
    const messagesCommand = memoryTool.commands.find((c) => c.name === 'session_messages');

    it('should validate contextId format', () => {
      const schema = messagesCommand!.argsSchema;

      // Valid UUID
      expect(() =>
        schema.parse({ contextId: '550e8400-e29b-41d4-a716-446655440000' })
      ).not.toThrow();

      // Invalid UUID
      expect(() => schema.parse({ contextId: 'not-a-uuid' })).toThrow();
    });

    it('should return error without userId', async () => {
      ctx.userId = undefined;

      const result = await messagesCommand!.handler(ctx, {
        contextId: '550e8400-e29b-41d4-a716-446655440000',
      });

      expect(result).toEqual({
        success: false,
        error: 'User context unavailable',
      });
    });
  });

  describe('configuration', () => {
    it('should validate config schema', () => {
      const schema = memoryTool.config?.schema;
      
      // Valid configs
      expect(() => schema!.parse({ search_limit: 25 })).not.toThrow();
      expect(() => schema!.parse({ include_active_default: true })).not.toThrow();
      expect(() => schema!.parse({})).not.toThrow();

      // Invalid configs
      expect(() => schema!.parse({ search_limit: 0 })).toThrow();
      expect(() => schema!.parse({ search_limit: 51 })).toThrow();
      expect(() => schema!.parse({ session_limit: 51 })).toThrow();
    });
  });
});
