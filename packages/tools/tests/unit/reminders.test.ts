/**
 * Unit tests for reminders tool
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { remindersTool } from '../../src/reminders.js';
import { createMockContext, createMockDb } from '../test-utils.js';
import type { ToolContext } from '@clifford/sdk';

describe('reminders tool [unit]', () => {
  let ctx: ToolContext;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
    ctx = createMockContext({ db: mockDb });
  });

  describe('metadata', () => {
    it('should have correct name', () => {
      expect(remindersTool.name).toBe('reminders');
    });

    it('should have all commands', () => {
      const commandNames = remindersTool.commands.map((c) => c.name);
      expect(commandNames).toContain('set');
      expect(commandNames).toContain('get');
      expect(commandNames).toContain('update');
      expect(commandNames).toContain('remove');
    });
  });

  describe('reminders.set', () => {
    const setCommand = remindersTool.commands.find((c) => c.name === 'set');

    it('should validate reminder schema', () => {
      const schema = setCommand!.argsSchema;

      const validReminder = {
        reminder: {
          name: 'Test reminder',
          description: 'Test description',
          dueAt: '2026-02-14T09:00:00Z',
          repeats: false,
          prompt: 'Test prompt',
        },
      };

      expect(() => schema.parse(validReminder)).not.toThrow();
    });

    it('should validate name length', () => {
      const schema = setCommand!.argsSchema;

      const reminder = {
        reminder: {
          name: 'a'.repeat(201), // Too long
          description: 'Test',
          dueAt: '2026-02-14T09:00:00Z',
          repeats: false,
          prompt: 'Test',
        },
      };

      expect(() => schema.parse(reminder)).toThrow();
    });

    it('should validate ISO datetime format', () => {
      const schema = setCommand!.argsSchema;

      const invalidReminder = {
        reminder: {
          name: 'Test',
          description: 'Test',
          dueAt: '2026-02-14', // Missing time
          repeats: false,
          prompt: 'Test',
        },
      };

      expect(() => schema.parse(invalidReminder)).toThrow();
    });

    it('should create reminder successfully', async () => {
      mockDb.limit.mockResolvedValue([]);
      mockDb.onConflictDoUpdate.mockResolvedValue(undefined);

      const result = await setCommand!.handler(ctx, {
        reminder: {
          name: 'Weekly review',
          description: 'Plan next week',
          dueAt: '2026-02-14T09:00:00Z',
          repeats: true,
          repeatRule: 'weekly',
          prompt: 'Time for review',
        },
      });

      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('reminder');
    });
  });

  describe('reminders.get', () => {
    const getCommand = remindersTool.commands.find((c) => c.name === 'get');

    it('should return all reminders when no name provided', async () => {
      const mockReminders = [
        {
          name: 'Reminder 1',
          description: 'Test 1',
          dueAt: '2026-02-14T09:00:00Z',
          repeats: false,
          prompt: 'Prompt 1',
        },
      ];

      mockDb.limit.mockResolvedValue([{ key: 'reminders', value: JSON.stringify(mockReminders) }]);

      const result = await getCommand!.handler(ctx, {});

      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('reminders');
      expect((result as any).reminders).toHaveLength(1);
    });

    it('should filter by name when provided', async () => {
      const mockReminders = [
        {
          name: 'Reminder 1',
          description: 'Test 1',
          dueAt: '2026-02-14T09:00:00Z',
          repeats: false,
          prompt: 'Prompt 1',
        },
        {
          name: 'Reminder 2',
          description: 'Test 2',
          dueAt: '2026-02-15T09:00:00Z',
          repeats: false,
          prompt: 'Prompt 2',
        },
      ];

      mockDb.limit.mockResolvedValue([{ key: 'reminders', value: JSON.stringify(mockReminders) }]);

      const result = await getCommand!.handler(ctx, { name: 'Reminder 1' });

      expect(result).toHaveProperty('success', true);
      expect((result as any).reminders).toHaveLength(1);
      expect((result as any).reminders[0].name).toBe('Reminder 1');
    });
  });

  describe('reminders.update', () => {
    const updateCommand = remindersTool.commands.find((c) => c.name === 'update');

    it('should update existing reminder', async () => {
      const existingReminders = [
        {
          name: 'Test',
          description: 'Old description',
          dueAt: '2026-02-14T09:00:00Z',
          repeats: false,
          prompt: 'Old prompt',
        },
      ];

      mockDb.limit.mockResolvedValue([
        { key: 'reminders', value: JSON.stringify(existingReminders) },
      ]);
      mockDb.onConflictDoUpdate.mockResolvedValue(undefined);

      const result = await updateCommand!.handler(ctx, {
        name: 'Test',
        updates: {
          description: 'New description',
        },
      });

      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('reminder');
      expect((result as any).reminder.description).toBe('New description');
    });

    it('should return error for non-existent reminder', async () => {
      mockDb.limit.mockResolvedValue([{ key: 'reminders', value: '[]' }]);

      const result = await updateCommand!.handler(ctx, {
        name: 'NonExistent',
        updates: { description: 'New' },
      });

      expect(result).toHaveProperty('success', false);
      expect(result).toHaveProperty('error', 'Reminder not found');
    });
  });

  describe('reminders.remove', () => {
    const removeCommand = remindersTool.commands.find((c) => c.name === 'remove');

    it('should have DESTRUCT classification', () => {
      expect(removeCommand!.classification).toBe('DESTRUCT');
    });

    it('should remove existing reminder', async () => {
      const existingReminders = [
        {
          name: 'ToRemove',
          description: 'Test',
          dueAt: '2026-02-14T09:00:00Z',
          repeats: false,
          prompt: 'Test',
        },
      ];

      mockDb.limit.mockResolvedValue([
        { key: 'reminders', value: JSON.stringify(existingReminders) },
      ]);
      mockDb.onConflictDoUpdate.mockResolvedValue(undefined);

      const result = await removeCommand!.handler(ctx, { name: 'ToRemove' });

      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('name', 'ToRemove');
    });

    it('should return error for non-existent reminder', async () => {
      mockDb.limit.mockResolvedValue([{ key: 'reminders', value: '[]' }]);

      const result = await removeCommand!.handler(ctx, { name: 'NonExistent' });

      expect(result).toHaveProperty('success', false);
      expect(result).toHaveProperty('error', 'Reminder not found');
    });
  });

  describe('configuration', () => {
    it('should validate config schema', () => {
      const schema = remindersTool.config?.schema;

      expect(() => schema!.parse({ max_reminders: 100 })).not.toThrow();
      expect(() => schema!.parse({ default_timezone: 'America/New_York' })).not.toThrow();

      // Invalid
      expect(() => schema!.parse({ max_reminders: 0 })).toThrow();
      expect(() => schema!.parse({ max_reminders: 1001 })).toThrow();
    });
  });
});
