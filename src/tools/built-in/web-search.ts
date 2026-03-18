import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { tagContent } from '../../security/content-trust.js';
import logger from '../../utils/logger.js';

interface SearchResult {
  title: string;
  url: string;
  description: string;
}

async function duckDuckGoSearch(query: string, count: number): Promise<SearchResult[]> {
  // Use DuckDuckGo HTML search — no API key needed
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    },
  });

  if (!response.ok) {
    throw new Error(`DuckDuckGo returned ${response.status}`);
  }

  const html = await response.text();
  const results: SearchResult[] = [];

  // Parse results from HTML — each result is in a div.result
  const resultBlocks = html.split('class="result__body"');
  for (let i = 1; i < resultBlocks.length && results.length < count; i++) {
    const block = resultBlocks[i];

    // Extract URL
    const urlMatch = block.match(/href="([^"]*?)"\s*class="result__url"/);
    const snippetUrlMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    const titleMatch = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/);
    const hrefMatch = block.match(/href="\/\/duckduckgo\.com\/l\/\?uddg=(.*?)&amp;/);

    let resultUrl = '';
    if (hrefMatch) {
      resultUrl = decodeURIComponent(hrefMatch[1]);
    } else if (urlMatch) {
      resultUrl = urlMatch[1].trim();
      if (!resultUrl.startsWith('http')) resultUrl = 'https://' + resultUrl;
    }

    const title = titleMatch
      ? titleMatch[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').trim()
      : '';

    const description = snippetUrlMatch
      ? snippetUrlMatch[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').trim()
      : '';

    if (title && resultUrl) {
      results.push({ title, url: resultUrl, description });
    }
  }

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
      const results = await duckDuckGoSearch(input.query, count);

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
