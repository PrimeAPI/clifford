import type { ToolContext, ToolDef } from '@clifford/sdk';
import { z } from 'zod';

// ============================================================================
// Schemas
// ============================================================================

const webSearchArgs = z.object({
  query: z
    .string()
    .min(1)
    .max(500)
    .describe('Search query. Max 500 characters. Natural language queries work best.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe('Maximum number of search results to return. Range: 1-20. Default: 10.'),
  region: z
    .string()
    .length(2)
    .optional()
    .describe('Two-letter region code for localized results (e.g., "us", "gb", "de"). Optional.'),
  safeSearch: z
    .enum(['off', 'moderate', 'strict'])
    .optional()
    .describe('Safe search level. Default: "moderate".'),
});

const webFetchArgs = z.object({
  url: z
    .string()
    .url()
    .max(2000)
    .describe('URL to fetch. Must be a valid HTTP/HTTPS URL. Max 2000 characters.'),
  format: z
    .enum(['text', 'markdown', 'html'])
    .optional()
    .describe('Output format: "text" (clean text), "markdown" (preserve structure), "html" (raw). Default: "text".'),
  maxLength: z
    .number()
    .int()
    .min(100)
    .max(100000)
    .optional()
    .describe('Maximum content length to return in characters. Range: 100-100,000. Default: 10,000.'),
  timeout: z
    .number()
    .int()
    .min(1)
    .max(30)
    .optional()
    .describe('Request timeout in seconds. Range: 1-30. Default: 10.'),
});

const webExtractArgs = z.object({
  url: z
    .string()
    .url()
    .max(2000)
    .describe('URL to extract data from. Must be a valid HTTP/HTTPS URL. Max 2000 characters.'),
  selector: z
    .string()
    .max(500)
    .optional()
    .describe('CSS selector to extract specific elements. Optional. Max 500 characters.'),
  extractType: z
    .enum(['text', 'links', 'images', 'tables', 'metadata'])
    .optional()
    .describe('Type of data to extract. Default: "text".'),
  timeout: z
    .number()
    .int()
    .min(1)
    .max(30)
    .optional()
    .describe('Request timeout in seconds. Range: 1-30. Default: 10.'),
});

// ============================================================================
// Helper Functions
// ============================================================================

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  position: number;
}

interface BraveSearchResponse {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
    }>;
  };
}

interface FetchResult {
  url: string;
  title?: string;
  content: string;
  contentLength: number;
  format: string;
}

interface ExtractResult {
  url: string;
  data: unknown;
  extractType: string;
}

/**
 * Search the web using Brave Search API
 * Requires BRAVE_SEARCH_API environment variable
 */
async function searchWeb(
  query: string,
  limit: number,
  region?: string,
  safeSearch?: string
): Promise<SearchResult[]> {
  const apiKey = process.env.BRAVE_SEARCH_API;

  if (!apiKey) {
    throw new Error('BRAVE_SEARCH_API environment variable is required for web search');
  }

  try {
    const params = new URLSearchParams({
      q: query,
      count: String(limit),
    });

    // Add optional parameters
    if (region) {
      params.set('country', region.toUpperCase());
    }

    if (safeSearch) {
      params.set('safesearch', safeSearch);
    }

    const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params.toString()}`, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`Search failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as BraveSearchResponse;

    // Parse Brave Search API response
    const results: SearchResult[] = [];

    if (data.web?.results && Array.isArray(data.web.results)) {
      for (let i = 0; i < Math.min(data.web.results.length, limit); i++) {
        const result = data.web.results[i];
        if (result && result.url && result.title) {
          results.push({
            title: result.title,
            url: result.url,
            snippet: result.description || '',
            position: i + 1,
          });
        }
      }
    }

    return results;
  } catch (error) {
    throw new Error(`Web search failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Fetch and parse content from a URL
 */
async function fetchUrl(
  url: string,
  format: 'text' | 'markdown' | 'html',
  maxLength: number,
  timeout: number
): Promise<FetchResult> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; Clifford-Agent/1.0; +https://github.com/clifford/agent)',
      },
      signal: AbortSignal.timeout(timeout * 1000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      throw new Error(`Unsupported content type: ${contentType}`);
    }

    const html = await response.text();

    let content: string;
    let title: string | undefined;

    if (format === 'html') {
      content = html;
      title = extractTitle(html);
    } else if (format === 'markdown') {
      const parsed = parseHTML(html);
      content = convertToMarkdown(parsed);
      title = parsed.title;
    } else {
      // text format
      const parsed = parseHTML(html);
      content = parsed.text;
      title = parsed.title;
    }

    // Truncate if needed
    if (content.length > maxLength) {
      content = content.slice(0, maxLength) + '\n\n[Content truncated...]';
    }

    return {
      url,
      title,
      content,
      contentLength: content.length,
      format,
    };
  } catch (error) {
    throw new Error(`Failed to fetch URL: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Extract specific data from a webpage
 */
async function extractFromUrl(
  url: string,
  selector: string | undefined,
  extractType: string,
  timeout: number
): Promise<ExtractResult> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; Clifford-Agent/1.0; +https://github.com/clifford/agent)',
      },
      signal: AbortSignal.timeout(timeout * 1000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();
    const parsed = parseHTML(html);

    let data: unknown;

    switch (extractType) {
      case 'links':
        data = parsed.links;
        break;
      case 'images':
        data = parsed.images;
        break;
      case 'metadata':
        data = parsed.metadata;
        break;
      case 'tables':
        data = parsed.tables || [];
        break;
      default:
        data = parsed.text;
    }

    return {
      url,
      data,
      extractType,
    };
  } catch (error) {
    throw new Error(`Failed to extract from URL: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ============================================================================
// HTML Parsing Utilities
// ============================================================================

interface ParsedHTML {
  title?: string;
  text: string;
  links: Array<{ text: string; url: string }>;
  images: Array<{ alt: string; src: string }>;
  metadata: Record<string, string>;
  tables?: Array<string[][]>;
}

/**
 * Basic HTML parser (without external dependencies)
 * Extracts text, links, images, and metadata
 */
function parseHTML(html: string): ParsedHTML {
  const result: ParsedHTML = {
    text: '',
    links: [],
    images: [],
    metadata: {},
  };

  // Extract title
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
  if (titleMatch) {
    result.title = decodeHTML(titleMatch[1]?.trim() || '');
  }

  // Extract metadata
  const metaPattern = /<meta\s+(?:name|property)="([^"]+)"\s+content="([^"]+)"/gi;
  let metaMatch;
  while ((metaMatch = metaPattern.exec(html)) !== null) {
    result.metadata[metaMatch[1] || ''] = decodeHTML(metaMatch[2] || '');
  }

  // Remove script and style tags
  let cleanHtml = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  cleanHtml = cleanHtml.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');

  // Extract links
  const linkPattern = /<a\s+[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi;
  let linkMatch;
  while ((linkMatch = linkPattern.exec(cleanHtml)) !== null) {
    const url = linkMatch[1] || '';
    const text = stripTags(linkMatch[2] || '').trim();
    if (url && text) {
      result.links.push({ text: decodeHTML(text), url: decodeHTML(url) });
    }
  }

  // Extract images
  const imgPattern = /<img\s+[^>]*src="([^"]+)"[^>]*(?:alt="([^"]*)")?[^>]*>/gi;
  let imgMatch;
  while ((imgMatch = imgPattern.exec(html)) !== null) {
    const src = imgMatch[1] || '';
    const alt = imgMatch[2] || '';
    if (src) {
      result.images.push({ src: decodeHTML(src), alt: decodeHTML(alt) });
    }
  }

  // Extract text content
  result.text = extractText(cleanHtml);

  return result;
}

function extractTitle(html: string): string | undefined {
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
  return titleMatch ? decodeHTML(titleMatch[1]?.trim() || '') : undefined;
}

function extractText(html: string): string {
  // Remove tags
  let text = stripTags(html);

  // Decode HTML entities
  text = decodeHTML(text);

  // Clean up whitespace
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ');
}

function decodeHTML(text: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
  };

  let decoded = text;
  for (const [entity, char] of Object.entries(entities)) {
    decoded = decoded.replaceAll(entity, char);
  }

  // Handle numeric entities
  decoded = decoded.replace(/&#(\d+);/g, (_, num) => String.fromCharCode(Number(num)));
  decoded = decoded.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

  return decoded;
}

function convertToMarkdown(parsed: ParsedHTML): string {
  let markdown = '';

  if (parsed.title) {
    markdown += `# ${parsed.title}\n\n`;
  }

  markdown += parsed.text + '\n\n';

  if (parsed.links.length > 0) {
    markdown += '## Links\n\n';
    for (const link of parsed.links.slice(0, 50)) {
      markdown += `- [${link.text}](${link.url})\n`;
    }
  }

  return markdown.trim();
}

// ============================================================================
// Tool Definition
// ============================================================================

export const webTool: ToolDef = {
  name: 'web',
  shortDescription: 'Web search, fetch, and content extraction',
  longDescription:
    'Search the web, fetch webpage content, and extract structured data from URLs. Use web.search to find information across the internet using Brave Search API (requires BRAVE_SEARCH_API env var). Use web.fetch to retrieve and parse webpage content in text, markdown, or HTML format. Use web.extract to pull specific data like links, images, or metadata from pages. Essential for accessing real-time information, documentation, news, and any web-based resources.',
  config: {
    fields: [
      {
        key: 'default_region',
        label: 'Default Region',
        description: 'Default two-letter region code for search results (e.g., "us", "gb").',
        type: 'string',
      },
      {
        key: 'default_safe_search',
        label: 'Default Safe Search',
        description: 'Default safe search level for web searches.',
        type: 'select',
        options: ['off', 'moderate', 'strict'],
      },
      {
        key: 'max_fetch_size',
        label: 'Max Fetch Size',
        description: 'Maximum content size to fetch from URLs (bytes). Default: 1MB.',
        type: 'number',
        min: 10000,
        max: 10000000,
      },
      {
        key: 'timeout',
        label: 'Request Timeout',
        description: 'Default timeout for web requests in seconds.',
        type: 'number',
        min: 1,
        max: 30,
      },
      {
        key: 'max_retries',
        label: 'Max Retries',
        description: 'Maximum retries when this tool fails.',
        type: 'number',
        min: 0,
        max: 5,
      },
      {
        key: 'expose_errors',
        label: 'Expose Errors',
        description: 'Include tool error details in user-facing messages.',
        type: 'boolean',
      },
    ],
    schema: z.object({
      default_region: z.string().length(2).optional(),
      default_safe_search: z.enum(['off', 'moderate', 'strict']).optional(),
      max_fetch_size: z.number().int().min(10000).max(10000000).optional(),
      timeout: z.number().int().min(1).max(30).optional(),
      max_retries: z.number().int().min(0).max(5).optional(),
      expose_errors: z.boolean().optional(),
    }),
  },
  commands: [
    {
      name: 'search',
      shortDescription: 'Search the web',
      longDescription:
        'Searches the web using Brave Search API and returns a list of relevant results with titles, URLs, and snippets. Returns up to "limit" results (1-20, default 10). Supports regional localization via "region" (two-letter country code) and safe search filtering. Requires BRAVE_SEARCH_API environment variable. Returns {results: [{title, url, snippet, position}], query, resultCount}.',
      usageExample:
        '{"name":"web.search","args":{"query":"autonomous agent frameworks 2024","limit":10,"region":"us"}}',
      argsSchema: webSearchArgs,
      classification: 'READ',
      handler: async (ctx: ToolContext, args: unknown) => {
        const { query, limit = 10, region, safeSearch } = webSearchArgs.parse(args);
        const config = (ctx.toolConfig ?? {}) as {
          default_region?: string;
          default_safe_search?: string;
        };

        try {
          const results = await searchWeb(
            query,
            limit,
            region ?? config.default_region,
            safeSearch ?? config.default_safe_search
          );

          ctx.logger.info({ query, resultCount: results.length }, 'Web search completed');

          return {
            success: true,
            query,
            resultCount: results.length,
            results,
          };
        } catch (error) {
          ctx.logger.error({ error, query }, 'Web search failed');
          return {
            success: false,
            error: 'search_failed',
            message: error instanceof Error ? error.message : String(error),
          };
        }
      },
    },
    {
      name: 'fetch',
      shortDescription: 'Fetch webpage content',
      longDescription:
        'Fetches and parses content from a URL. Returns content in the specified format: "text" (clean readable text), "markdown" (structured with headers/links), or "html" (raw HTML). Automatically handles encoding and extracts the page title. Respects maxLength limit (100-100,000 chars, default 10,000). Timeout range: 1-30 seconds (default 10). Returns {url, title, content, contentLength, format}. Useful for reading articles, documentation, or any web content.',
      usageExample:
        '{"name":"web.fetch","args":{"url":"https://example.com/article","format":"markdown","maxLength":20000}}',
      argsSchema: webFetchArgs,
      classification: 'READ',
      handler: async (ctx: ToolContext, args: unknown) => {
        const {
          url,
          format = 'text',
          maxLength = 10000,
          timeout = 10,
        } = webFetchArgs.parse(args);

        try {
          const result = await fetchUrl(url, format, maxLength, timeout);

          ctx.logger.info({ url, format, contentLength: result.contentLength }, 'Web fetch completed');

          return {
            success: true,
            ...result,
          };
        } catch (error) {
          ctx.logger.error({ error, url }, 'Web fetch failed');
          return {
            success: false,
            error: 'fetch_failed',
            message: error instanceof Error ? error.message : String(error),
          };
        }
      },
    },
    {
      name: 'extract',
      shortDescription: 'Extract structured data from URL',
      longDescription:
        'Extracts specific structured data from a webpage. Specify extractType: "text" (main content), "links" (all hyperlinks with text), "images" (all images with alt text), "metadata" (meta tags), or "tables" (table data). Optional CSS selector for targeted extraction. Timeout range: 1-30 seconds (default 10). Returns {url, data, extractType}. Useful for scraping structured information from web pages.',
      usageExample:
        '{"name":"web.extract","args":{"url":"https://example.com","extractType":"links"}}',
      argsSchema: webExtractArgs,
      classification: 'READ',
      handler: async (ctx: ToolContext, args: unknown) => {
        const { url, selector, extractType = 'text', timeout = 10 } = webExtractArgs.parse(args);

        try {
          const result = await extractFromUrl(url, selector, extractType, timeout);

          ctx.logger.info({ url, extractType }, 'Web extract completed');

          return {
            success: true,
            ...result,
          };
        } catch (error) {
          ctx.logger.error({ error, url }, 'Web extract failed');
          return {
            success: false,
            error: 'extract_failed',
            message: error instanceof Error ? error.message : String(error),
          };
        }
      },
    },
  ],
};
