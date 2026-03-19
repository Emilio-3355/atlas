import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { getEnv } from '../../config/env.js';
import { tagContent } from '../../security/content-trust.js';
import { loadPage, safeClosePage } from '../../services/browser.js';
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

/** Fallback: search via DuckDuckGo HTML (no API key needed, no CAPTCHA) */
async function duckDuckGoSearch(searchQuery: string, count: number): Promise<SearchResult[]> {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
    if (!response.ok) return [];

    const html = await response.text();
    const results: SearchResult[] = [];

    // Parse DDG HTML results — each result is in a <div class="result">
    const resultBlocks = html.split('<div class="result ');
    for (let i = 1; i < resultBlocks.length && results.length < count; i++) {
      const block = resultBlocks[i];
      // Extract URL from <a class="result__a" href="...">
      const urlMatch = block.match(/href="([^"]+)"/);
      const titleMatch = block.match(/class="result__a"[^>]*>([^<]+)/);
      const descMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);

      if (urlMatch && titleMatch) {
        let href = urlMatch[1];
        // DDG uses redirect URLs — extract actual URL
        if (href.includes('uddg=')) {
          const uddg = new URL(href, 'https://duckduckgo.com').searchParams.get('uddg');
          if (uddg) href = uddg;
        }
        results.push({
          title: titleMatch[1].trim(),
          url: href,
          description: descMatch ? descMatch[1].replace(/<[^>]+>/g, '').trim().slice(0, 200) : '',
        });
      }
    }

    return results;
  } catch (err) {
    logger.warn('DuckDuckGo search failed', { error: err, query: searchQuery });
    return [];
  }
}

/** Fallback: search via Google using Playwright headless browser */
async function browserSearch(searchQuery: string, count: number): Promise<SearchResult[]> {
  const url = `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}&num=${count}&hl=en`;

  const result = await loadPage(url, 2000);
  const { page, content } = result;

  // Detect CAPTCHA / blocking
  const isCaptcha = content.includes('unusual traffic') || content.includes('reCAPTCHA') || content.includes('not a robot');
  if (isCaptcha) {
    await safeClosePage(page);
    logger.warn('Google CAPTCHA detected', { query: searchQuery });
    return [];
  }

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

  await safeClosePage(page);
  return results;
}

/** Quick HEAD request to verify a URL is reachable (not 404/5xx) */
async function verifyUrl(url: string): Promise<{ ok: boolean; status: number }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Atlas/1.0)' },
    });
    clearTimeout(timeout);
    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false, status: 0 };
  }
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
      let searchEngine = 'brave';

      // Fallback to DuckDuckGo (no API key, no CAPTCHA)
      if (results.length === 0) {
        logger.info('Brave unavailable, trying DuckDuckGo', { query: input.query });
        results = await duckDuckGoSearch(input.query, count);
        searchEngine = 'duckduckgo';
      }

      // Fallback to browser-based Google search
      if (results.length === 0) {
        logger.info('DuckDuckGo unavailable, falling back to browser Google search', { query: input.query });
        results = await browserSearch(input.query, count);
        searchEngine = 'google';
      }

      if (results.length === 0) {
        // Return as FAILURE so the agent knows to try a different approach
        return {
          success: false,
          error: 'All search engines failed (Brave unavailable, DuckDuckGo returned no results, Google blocked by CAPTCHA). Try using the browse tool directly on a known URL like Google Maps, Yelp, or the business website. Do NOT tell the user to search themselves.',
        };
      }

      // Verify top URLs in parallel (max 3 to keep it fast)
      const verifications = await Promise.all(
        results.slice(0, 3).map(async (r) => {
          const check = await verifyUrl(r.url);
          return { url: r.url, ...check };
        })
      );

      const deadUrls = new Set(verifications.filter(v => !v.ok).map(v => v.url));

      const formatted = results.map((r) => {
        const dead = deadUrls.has(r.url) ? ' ⚠️ URL may be broken' : '';
        return `• *${r.title}*${dead}\n  ${r.url}\n  ${tagContent(r.description, 'untrusted', 'web_search')}`;
      }).join('\n\n');

      return { success: true, data: { results, formatted, count: results.length, deadUrls: [...deadUrls] } };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error('Web search error', { error: errMsg, query: input.query });
      return { success: false, error: errMsg };
    }
  },
};
