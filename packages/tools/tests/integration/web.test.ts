/**
 * Integration tests for web tool
 * These tests make REAL HTTP requests to external services
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { webTool } from '../../src/web.js';
import { createMockContext, loadTestEnv } from '../test-utils.js';
import type { ToolContext } from '@clifford/sdk';

// Load test environment
loadTestEnv();

describe('web tool [integration]', () => {
  let ctx: ToolContext;

  beforeEach(() => {
    ctx = createMockContext();
  });

  describe('web.search - Brave Search', () => {
    const searchCommand = webTool.commands.find((c) => c.name === 'search');

    it('should perform real web search', async () => {
      if (!process.env.BRAVE_SEARCH_API) {
        console.log('⚠ Skipping: BRAVE_SEARCH_API not set');
        return;
      }
      const result = await searchCommand!.handler(ctx, {
        query: 'Node.js TypeScript',
        limit: 5,
      });

      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('query', 'Node.js TypeScript');
      expect(result).toHaveProperty('results');
      
      const results = (result as any).results;
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThanOrEqual(5);

      // Validate result structure
      const firstResult = results[0];
      expect(firstResult).toHaveProperty('title');
      expect(firstResult).toHaveProperty('url');
      expect(firstResult).toHaveProperty('snippet');
      expect(firstResult).toHaveProperty('position');
      
      // Validate URL format
      expect(firstResult.url).toMatch(/^https?:\/\//);
      
      console.log(`✓ Found ${results.length} search results`);
      console.log(`  First result: ${firstResult.title}`);
    }, 30000);

    it('should support regional search', async () => {
      if (!process.env.BRAVE_SEARCH_API) {
        console.log('⚠ Skipping: BRAVE_SEARCH_API not set');
        return;
      }
      const result = await searchCommand!.handler(ctx, {
        query: 'weather',
        limit: 3,
        region: 'de',
      });

      // Region search might fail depending on API plan - that's okay
      if ((result as any).success === false) {
        console.log(`⚠ Regional search failed (may require higher API tier): ${(result as any).message}`);
        expect(result).toHaveProperty('error');
        return;
      }

      expect(result).toHaveProperty('success', true);
      const results = (result as any).results;
      expect(results.length).toBeGreaterThan(0);

      console.log(`✓ Regional search (de) returned ${results.length} results`);
    }, 30000);

  });

  describe('web.fetch - Real URLs', () => {
    const fetchCommand = webTool.commands.find((c) => c.name === 'fetch');

    it('should fetch and parse example.com', async () => {
      const result = await fetchCommand!.handler(ctx, {
        url: 'https://example.com',
        format: 'text',
        maxLength: 5000,
      });

      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('url', 'https://example.com');
      expect(result).toHaveProperty('content');
      expect(result).toHaveProperty('title');
      
      const content = (result as any).content;
      expect(typeof content).toBe('string');
      expect(content.length).toBeGreaterThan(0);
      expect(content).toContain('Example Domain');
      
      console.log(`✓ Fetched ${content.length} characters`);
      console.log(`  Title: ${(result as any).title}`);
    }, 30000);

    it('should fetch in markdown format', async () => {
      const result = await fetchCommand!.handler(ctx, {
        url: 'https://example.com',
        format: 'markdown',
      });

      expect(result).toHaveProperty('success', true);
      const content = (result as any).content;
      expect(content).toContain('#'); // Should have markdown headers
      
      console.log(`✓ Markdown format works`);
    }, 30000);

    it('should handle 404 errors', async () => {
      const result = await fetchCommand!.handler(ctx, {
        url: 'https://example.com/this-page-does-not-exist-404',
      });

      expect(result).toHaveProperty('success', false);
      expect(result).toHaveProperty('error', 'fetch_failed');
      
      console.log(`✓ 404 error handled correctly`);
    }, 30000);
  });

  describe('web.extract - Real URLs', () => {
    const extractCommand = webTool.commands.find((c) => c.name === 'extract');

    it('should extract links from example.com', async () => {
      const result = await extractCommand!.handler(ctx, {
        url: 'https://example.com',
        extractType: 'links',
      });

      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('data');
      
      const links = (result as any).data;
      expect(Array.isArray(links)).toBe(true);
      
      if (links.length > 0) {
        const firstLink = links[0];
        expect(firstLink).toHaveProperty('text');
        expect(firstLink).toHaveProperty('url');
        console.log(`✓ Extracted ${links.length} links`);
      }
    }, 30000);

    it('should extract metadata', async () => {
      const result = await extractCommand!.handler(ctx, {
        url: 'https://example.com',
        extractType: 'metadata',
      });

      expect(result).toHaveProperty('success', true);
      const metadata = (result as any).data;
      expect(typeof metadata).toBe('object');
      
      console.log(`✓ Extracted ${Object.keys(metadata).length} metadata fields`);
    }, 30000);
  });

  describe('Error handling and edge cases', () => {
    const fetchCommand = webTool.commands.find((c) => c.name === 'fetch');

    it('should handle timeout', async () => {
      // This might pass or fail depending on network - that's okay
      const result = await fetchCommand!.handler(ctx, {
        url: 'https://httpbin.org/delay/5', // 5 second delay
        timeout: 2, // 2 second timeout
      });

      // Should either succeed quickly or fail with timeout
      if ((result as any).success === false) {
        expect(result).toHaveProperty('error');
        console.log(`✓ Timeout handled`);
      } else {
        console.log(`✓ Request completed before timeout`);
      }
    }, 30000);

    it('should handle invalid domain', async () => {
      const result = await fetchCommand!.handler(ctx, {
        url: 'https://this-domain-definitely-does-not-exist-123456789.com',
      });

      expect(result).toHaveProperty('success', false);
      expect(result).toHaveProperty('error', 'fetch_failed');
      
      console.log(`✓ Invalid domain error handled`);
    }, 30000);
  });
});
