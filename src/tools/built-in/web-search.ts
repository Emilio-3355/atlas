import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { getEnv } from '../../config/env.js';
import { tagContent } from '../../security/content-trust.js';
import { loadPage } from '../../services/browser.js';
import logger from '../../utils/logger.js';

interface SearchResult {
  title: string;
  url: string;
  description: string;
}

/** Search via Brave API (if key available) */
async function braveSearch(query: string, count: number): Promise<SearchResult[]> {
  const key = getEnv().BRAVE_SEARCH_API_KEY;
  if (!key || key === 'PLACEHOLDER') return [];

  const response = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
    {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': key,
      },
    }
  );

  if (!response.ok) return [];

  const data = await response.json() as any;
  return (data.web?.results || []).map((r: any) => ({
    title: r.title,
    url: r.url,
    description: r.description,
  }));
}

/** Fallback: search via Google using Playwright headless browser */
async function browserSearch(query: string, count: number): Promise<SearchResult[]> {
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${count}&hl=en`;

  const { page, content } = await loadPage(url, 2000);

  // Extract structured results from the page (runs in browser context)
  const results = await page.evaluate(`
    (() => {
      const items = [];
      const links = document.querySelectorAll('a[href^="http"]:not([href*="google"])');
      const seen = new Set();
      for (const link of links) {
        if (items.length >= ${count}) break;
        const href = link.getAttribute('href') || '';
        if (!href || seen.has(href)) continue;
        if (href.includes('google.com') || href.includes('youtube.com/results') || href.includes('accounts.google')) continue;
        const heading = link.querySelector('h3');
        if (!heading) continue;
        const title = (heading.textContent || '').trim();
        if (!title) continue;
        seen.add(href);
        const parent = link.closest('[class]');
        const grandparent = parent ? parent.parentElement : null;
        const container = grandparent ? grandparent.parentElement : null;
        let description = '';
        if (container) {
          const spans = container.querySelectorAll('span, div');
          for (const span of spans) {
            const text = (span.textContent || '').trim();
            if (text.length > 50 && text !== title && !text.includes(href)) {
              description = text.slice(0, 200);
              break;
            }
          }
        }
        items.push({ title, url: href, description });
      }
      return items;
    })()
  `) as SearchResult[];

  await page.close();
  return results;
}

export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  description: 'Search the web for current information. Returns titles, URLs, and snippets. Use for finding restaurants, events, prices, news, etc.',
  category: 'informational',
  requiresApproval: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string', description: 'Search query' },
      count: { type: 'number', description: 'Number of results (default 5, max 10)' },
    },
    required: ['query'],
  },
  enabled: true,
  builtIn: true,

  async execute(input: { query: string; count?: number }, ctx: ToolContext): Promise<ToolResult> {
    const count = Math.min(input.count || 5, 10);

    try {
      // Try Brave first (if key available)
      let results = await braveSearch(input.query, count);

      // Fallback to browser-based Google search
      if (results.length === 0) {
        logger.info('Brave unavailable, falling back to browser search', { query: input.query });
        results = await browserSearch(input.query, count);
      }

      if (results.length === 0) {
        return { success: true, data: { results: [], formatted: 'No results found.', count: 0 } };
      }

      const formatted = results.map((r) =>
        `• *${r.title}*\n  ${r.url}\n  ${tagContent(r.description, 'untrusted', 'web_search')}`
      ).join('\n\n');

      return { success: true, data: { results, formatted, count: results.length } };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error('Web search error', { error: errMsg, query: input.query });
      return { success: false, error: errMsg };
    }
  },
};
