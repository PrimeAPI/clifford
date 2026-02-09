/**
 * Unit tests for web tool
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { webTool } from '../../src/web.js';
import { createMockContext, mockGlobalFetch, restoreGlobalFetch, createMockFetchResponse } from '../test-utils.js';
import type { ToolContext } from '@clifford/sdk';

describe('web tool [unit]', () => {
  let ctx: ToolContext;

  beforeEach(() => {
    ctx = createMockContext();
  });

  afterEach(() => {
    restoreGlobalFetch();
  });

  describe('metadata', () => {
    it('should have correct name', () => {
      expect(webTool.name).toBe('web');
    });

    it('should have all commands', () => {
      const commandNames = webTool.commands.map((c) => c.name);
      expect(commandNames).toContain('search');
      expect(commandNames).toContain('fetch');
      expect(commandNames).toContain('extract');
    });
  });

  describe('web.search', () => {
    const searchCommand = webTool.commands.find((c) => c.name === 'search');

    it('should have READ classification', () => {
      expect(searchCommand!.classification).toBe('READ');
    });

    it('should validate query length', () => {
      const schema = searchCommand!.argsSchema;

      // Valid
      expect(() => schema.parse({ query: 'test' })).not.toThrow();
      expect(() => schema.parse({ query: 'a'.repeat(500) })).not.toThrow();

      // Invalid
      expect(() => schema.parse({ query: '' })).toThrow();
      expect(() => schema.parse({ query: 'a'.repeat(501) })).toThrow();
    });

    it('should validate limit range', () => {
      const schema = searchCommand!.argsSchema;

      // Valid
      expect(() => schema.parse({ query: 'test', limit: 1 })).not.toThrow();
      expect(() => schema.parse({ query: 'test', limit: 20 })).not.toThrow();

      // Invalid
      expect(() => schema.parse({ query: 'test', limit: 0 })).toThrow();
      expect(() => schema.parse({ query: 'test', limit: 21 })).toThrow();
    });

    it('should validate region code', () => {
      const schema = searchCommand!.argsSchema;

      // Valid
      expect(() => schema.parse({ query: 'test', region: 'us' })).not.toThrow();
      expect(() => schema.parse({ query: 'test', region: 'gb' })).not.toThrow();

      // Invalid
      expect(() => schema.parse({ query: 'test', region: 'usa' })).toThrow();
      expect(() => schema.parse({ query: 'test', region: 'u' })).toThrow();
    });

    it('should return search results on success', async () => {
      const mockApiResponse = {
        web: {
          results: [
            {
              title: 'Example Title',
              url: 'https://example.com',
              description: 'Example snippet text',
            },
          ],
        },
      };

      mockGlobalFetch(async () => createMockFetchResponse(JSON.stringify(mockApiResponse)));

      // Mock BRAVE_SEARCH_API env var
      const originalEnv = process.env.BRAVE_SEARCH_API;
      process.env.BRAVE_SEARCH_API = 'test-api-key';

      const result = await searchCommand!.handler(ctx, {
        query: 'test query',
        limit: 10,
      });

      // Restore env
      if (originalEnv === undefined) {
        delete process.env.BRAVE_SEARCH_API;
      } else {
        process.env.BRAVE_SEARCH_API = originalEnv;
      }

      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('query', 'test query');
      expect(result).toHaveProperty('results');
      expect(Array.isArray((result as any).results)).toBe(true);
    });

    it('should handle search failure', async () => {
      mockGlobalFetch(async () => {
        throw new Error('Network error');
      });

      // Mock BRAVE_SEARCH_API env var
      const originalEnv = process.env.BRAVE_SEARCH_API;
      process.env.BRAVE_SEARCH_API = 'test-api-key';

      const result = await searchCommand!.handler(ctx, {
        query: 'test query',
      });

      // Restore env
      if (originalEnv === undefined) {
        delete process.env.BRAVE_SEARCH_API;
      } else {
        process.env.BRAVE_SEARCH_API = originalEnv;
      }

      expect(result).toHaveProperty('success', false);
      expect(result).toHaveProperty('error', 'search_failed');
    });

    it('should log search completion', async () => {
      mockGlobalFetch(async () => createMockFetchResponse(JSON.stringify({ web: { results: [] } })));

      // Mock BRAVE_SEARCH_API env var
      const originalEnv = process.env.BRAVE_SEARCH_API;
      process.env.BRAVE_SEARCH_API = 'test-api-key';

      await searchCommand!.handler(ctx, { query: 'test' });

      // Restore env
      if (originalEnv === undefined) {
        delete process.env.BRAVE_SEARCH_API;
      } else {
        process.env.BRAVE_SEARCH_API = originalEnv;
      }

      expect(ctx.logger.info).toHaveBeenCalled();
    });

    it('should fail when BRAVE_SEARCH_API is not set', async () => {
      const originalEnv = process.env.BRAVE_SEARCH_API;
      delete process.env.BRAVE_SEARCH_API;

      const result = await searchCommand!.handler(ctx, {
        query: 'test query',
      });

      // Restore env
      if (originalEnv !== undefined) {
        process.env.BRAVE_SEARCH_API = originalEnv;
      }

      expect(result).toHaveProperty('success', false);
      expect(result).toHaveProperty('error', 'search_failed');
      expect((result as any).message).toContain('BRAVE_SEARCH_API');
    });
  });

  describe('web.fetch', () => {
    const fetchCommand = webTool.commands.find((c) => c.name === 'fetch');

    it('should validate URL', () => {
      const schema = fetchCommand!.argsSchema;

      // Valid URLs
      expect(() => schema.parse({ url: 'https://example.com' })).not.toThrow();
      expect(() => schema.parse({ url: 'http://example.com' })).not.toThrow();

      // Invalid URLs
      expect(() => schema.parse({ url: 'not-a-url' })).toThrow();
      // Note: Zod's .url() validator accepts ftp:// as valid URL
    });

    it('should validate format enum', () => {
      const schema = fetchCommand!.argsSchema;

      // Valid formats
      expect(() => schema.parse({ url: 'https://example.com', format: 'text' })).not.toThrow();
      expect(() => schema.parse({ url: 'https://example.com', format: 'markdown' })).not.toThrow();
      expect(() => schema.parse({ url: 'https://example.com', format: 'html' })).not.toThrow();

      // Invalid format
      expect(() => schema.parse({ url: 'https://example.com', format: 'pdf' })).toThrow();
    });

    it('should validate maxLength range', () => {
      const schema = fetchCommand!.argsSchema;

      // Valid
      expect(() => schema.parse({ url: 'https://example.com', maxLength: 100 })).not.toThrow();
      expect(() => schema.parse({ url: 'https://example.com', maxLength: 100000 })).not.toThrow();

      // Invalid
      expect(() => schema.parse({ url: 'https://example.com', maxLength: 99 })).toThrow();
      expect(() => schema.parse({ url: 'https://example.com', maxLength: 100001 })).toThrow();
    });

    it('should validate timeout range', () => {
      const schema = fetchCommand!.argsSchema;

      // Valid
      expect(() => schema.parse({ url: 'https://example.com', timeout: 1 })).not.toThrow();
      expect(() => schema.parse({ url: 'https://example.com', timeout: 30 })).not.toThrow();

      // Invalid
      expect(() => schema.parse({ url: 'https://example.com', timeout: 0 })).toThrow();
      expect(() => schema.parse({ url: 'https://example.com', timeout: 31 })).toThrow();
    });

    it('should fetch and parse HTML', async () => {
      const mockHtml = `
        <html>
          <head><title>Test Page</title></head>
          <body><p>Test content</p></body>
        </html>
      `;

      mockGlobalFetch(async () => createMockFetchResponse(mockHtml));

      const result = await fetchCommand!.handler(ctx, {
        url: 'https://example.com',
        format: 'text',
      });

      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('url', 'https://example.com');
      expect(result).toHaveProperty('content');
      expect(result).toHaveProperty('format', 'text');
    });

    it('should handle fetch errors', async () => {
      mockGlobalFetch(async () => {
        return createMockFetchResponse('', { ok: false, status: 404, statusText: 'Not Found' });
      });

      const result = await fetchCommand!.handler(ctx, {
        url: 'https://example.com',
      });

      expect(result).toHaveProperty('success', false);
      expect(result).toHaveProperty('error', 'fetch_failed');
    });

    it('should truncate content if too long', async () => {
      const longContent = 'x'.repeat(20000);
      const mockHtml = `<html><body>${longContent}</body></html>`;

      mockGlobalFetch(async () => createMockFetchResponse(mockHtml));

      const result = await fetchCommand!.handler(ctx, {
        url: 'https://example.com',
        maxLength: 1000,
      });

      expect(result).toHaveProperty('success', true);
      const content = (result as any).content;
      expect(content.length).toBeLessThanOrEqual(1050); // 1000 + truncation message
    });
  });

  describe('web.extract', () => {
    const extractCommand = webTool.commands.find((c) => c.name === 'extract');

    it('should validate extractType enum', () => {
      const schema = extractCommand!.argsSchema;

      // Valid types
      const validTypes = ['text', 'links', 'images', 'tables', 'metadata'];
      validTypes.forEach((type) => {
        expect(() =>
          schema.parse({ url: 'https://example.com', extractType: type })
        ).not.toThrow();
      });

      // Invalid type
      expect(() =>
        schema.parse({ url: 'https://example.com', extractType: 'videos' })
      ).toThrow();
    });

    it('should extract links from HTML', async () => {
      const mockHtml = `
        <html>
          <body>
            <a href="https://example.com/page1">Link 1</a>
            <a href="https://example.com/page2">Link 2</a>
          </body>
        </html>
      `;

      mockGlobalFetch(async () => createMockFetchResponse(mockHtml));

      const result = await extractCommand!.handler(ctx, {
        url: 'https://example.com',
        extractType: 'links',
      });

      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('data');
      expect(Array.isArray((result as any).data)).toBe(true);
      expect((result as any).data.length).toBeGreaterThan(0);
    });

    it('should extract images from HTML', async () => {
      const mockHtml = `
        <html>
          <body>
            <img src="https://example.com/img1.jpg" alt="Image 1">
            <img src="https://example.com/img2.jpg" alt="Image 2">
          </body>
        </html>
      `;

      mockGlobalFetch(async () => createMockFetchResponse(mockHtml));

      const result = await extractCommand!.handler(ctx, {
        url: 'https://example.com',
        extractType: 'images',
      });

      expect(result).toHaveProperty('success', true);
      expect(Array.isArray((result as any).data)).toBe(true);
    });

    it('should extract metadata from HTML', async () => {
      const mockHtml = `
        <html>
          <head>
            <meta name="description" content="Test description">
            <meta property="og:title" content="Test OG Title">
          </head>
        </html>
      `;

      mockGlobalFetch(async () => createMockFetchResponse(mockHtml));

      const result = await extractCommand!.handler(ctx, {
        url: 'https://example.com',
        extractType: 'metadata',
      });

      expect(result).toHaveProperty('success', true);
      expect(typeof (result as any).data).toBe('object');
    });
  });

  describe('configuration', () => {
    it('should validate config schema', () => {
      const schema = webTool.config?.schema;

      // Valid configs
      expect(() => schema!.parse({ default_region: 'us' })).not.toThrow();
      expect(() => schema!.parse({ default_safe_search: 'moderate' })).not.toThrow();
      expect(() => schema!.parse({ timeout: 15 })).not.toThrow();
      expect(() => schema!.parse({})).not.toThrow();

      // Invalid configs
      expect(() => schema!.parse({ default_region: 'usa' })).toThrow();
      expect(() => schema!.parse({ default_safe_search: 'invalid' })).toThrow();
      expect(() => schema!.parse({ timeout: 0 })).toThrow();
      expect(() => schema!.parse({ timeout: 31 })).toThrow();
    });
  });
});
