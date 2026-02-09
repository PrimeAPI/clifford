/**
 * Test utilities and mocks for tool testing
 */

import type { ToolContext, Logger } from '@clifford/sdk';
import type { Mock } from 'vitest';
import { vi } from 'vitest';

/**
 * Create a mock logger for testing
 */
export function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/**
 * Create a mock tool context for testing
 */
export function createMockContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    tenantId: 'test-tenant-id',
    agentId: 'test-agent-id',
    runId: 'test-run-id',
    db: createMockDb(),
    logger: createMockLogger(),
    userId: 'test-user-id',
    channelId: 'test-channel-id',
    toolConfig: {},
    toolResolver: undefined,
    ...overrides,
  };
}

/**
 * Create a mock database for testing
 */
export function createMockDb() {
  const mockChain: any = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    insert: vi.fn(),
    values: vi.fn(),
    delete: vi.fn(),
    onConflictDoUpdate: vi.fn(),
    limit: vi.fn(),
    orderBy: vi.fn(),
    returning: vi.fn(),
    execute: vi.fn(),
  };

  // Make all methods chainable by default - they return the mock chain itself
  mockChain.select.mockReturnValue(mockChain);
  mockChain.from.mockReturnValue(mockChain);
  mockChain.where.mockReturnValue(mockChain);
  mockChain.insert.mockReturnValue(mockChain);
  mockChain.values.mockReturnValue(mockChain);
  mockChain.delete.mockReturnValue(mockChain);
  mockChain.onConflictDoUpdate.mockReturnValue(mockChain);
  mockChain.limit.mockReturnValue(mockChain);
  mockChain.orderBy.mockReturnValue(mockChain);
  mockChain.returning.mockResolvedValue([]);
  mockChain.execute.mockResolvedValue({ rows: [] });

  return mockChain;
}

/**
 * Create a mock fetch response for testing web tools
 */
export function createMockFetchResponse(body: string, options?: Partial<Response>): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({
      'content-type': 'text/html; charset=utf-8',
    }),
    text: async () => body,
    json: async () => JSON.parse(body),
    ...options,
  } as Response;
}

/**
 * Mock fetch globally for tests
 */
export function mockGlobalFetch(implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  global.fetch = vi.fn(implementation);
  return global.fetch as Mock;
}

/**
 * Restore original fetch after mocking
 */
export function restoreGlobalFetch() {
  vi.restoreAllMocks();
}

/**
 * Load environment variables from .env.test if it exists
 */
export function loadTestEnv() {
  try {
    const fs = require('fs');
    const path = require('path');
    const envPath = path.join(process.cwd(), '.env.test');
    
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf-8');
      envContent.split('\n').forEach((line: string) => {
        const match = line.match(/^([^#][^=]+)=(.*)$/);
        if (match) {
          const [, key, value] = match;
          process.env[key.trim()] = value.trim();
        }
      });
    }
  } catch (error) {
    // Ignore errors loading .env.test
  }
}

/**
 * Check if integration tests should be skipped
 */
export function shouldSkipIntegration(): boolean {
  return process.env.TEST_SKIP_INTEGRATION === 'true';
}

/**
 * Skip test if integration tests are disabled
 */
export function skipIfNoIntegration(test: () => void): void {
  if (shouldSkipIntegration()) {
    test.skip('Integration tests disabled via TEST_SKIP_INTEGRATION');
  }
}
