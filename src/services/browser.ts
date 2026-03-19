import { chromium, type Browser, type Page } from 'playwright';
import logger from '../utils/logger.js';

let browser: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });
    logger.info('Playwright browser launched');
  }
  return browser;
}

export async function createPage(): Promise<Page> {
  const b = await getBrowser();
  const context = await b.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  return context.newPage();
}

export interface PageLink {
  text: string;
  url: string;
}

export interface LoadPageResult {
  page: Page;
  content: string;
  links: PageLink[];
  status: number;
}

export async function loadPage(url: string, waitMs: number = 3000): Promise<LoadPageResult> {
  const page = await createPage();

  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const status = response?.status() ?? 0;
    await page.waitForTimeout(waitMs);

    // Extract readable text AND links (runs in browser context)
    const extracted = await page.evaluate(`
      (() => {
        // Extract links BEFORE removing nav/footer (they contain useful navigation links)
        const links = [];
        const seen = new Set();
        document.querySelectorAll('a[href]').forEach(a => {
          const href = a.getAttribute('href') || '';
          const text = (a.textContent || '').trim().slice(0, 100);
          if (!href || !text || text.length < 2) return;
          // Resolve relative URLs
          let fullUrl;
          try { fullUrl = new URL(href, document.location.href).href; } catch { return; }
          if (seen.has(fullUrl)) return;
          if (fullUrl.startsWith('javascript:') || fullUrl.startsWith('mailto:') || fullUrl.startsWith('#')) return;
          seen.add(fullUrl);
          links.push({ text, url: fullUrl });
        });

        // Now strip non-content elements for text extraction
        const removeSelectors = ['script', 'style', 'nav', 'footer', 'header', 'iframe', 'noscript'];
        for (const sel of removeSelectors) {
          document.querySelectorAll(sel).forEach(el => el.remove());
        }
        const body = document.body;
        const content = body ? body.innerText.replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 10000) : '';
        return { content, links: links.slice(0, 50) };
      })()
    `) as { content: string; links: PageLink[] };

    return { page, content: extracted.content, links: extracted.links, status };
  } catch (err) {
    await page.close();
    throw err;
  }
}

export async function takeScreenshot(url: string): Promise<Buffer> {
  const page = await createPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);
    const screenshot = await page.screenshot({ type: 'png', fullPage: false });
    return screenshot;
  } finally {
    await page.close();
  }
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
    logger.info('Browser closed');
  }
}

// ===== Network Monitoring =====

interface NetworkEntry {
  url: string;
  method: string;
  status: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  resourceType: string;
  timestamp: number;
  duration: number;
}

const networkLogs = new Map<string, NetworkEntry[]>();
const MAX_LOG_ENTRIES = 500;

/**
 * Create a page with network monitoring enabled.
 * All requests/responses are captured in the network log.
 */
export async function createMonitoredPage(profileId: string = 'default'): Promise<Page> {
  const page = await createPage();

  if (!networkLogs.has(profileId)) {
    networkLogs.set(profileId, []);
  }
  const log = networkLogs.get(profileId)!;

  const pendingRequests = new Map<string, { url: string; method: string; headers: Record<string, string>; resourceType: string; startTime: number }>();

  page.on('request', (request) => {
    pendingRequests.set(request.url() + request.method(), {
      url: request.url(),
      method: request.method(),
      headers: request.headers(),
      resourceType: request.resourceType(),
      startTime: Date.now(),
    });
  });

  page.on('response', async (response) => {
    const key = response.url() + response.request().method();
    const pending = pendingRequests.get(key);
    if (!pending) return;
    pendingRequests.delete(key);

    const entry: NetworkEntry = {
      url: pending.url,
      method: pending.method,
      status: response.status(),
      requestHeaders: pending.headers,
      responseHeaders: response.headers(),
      resourceType: pending.resourceType,
      timestamp: pending.startTime,
      duration: Date.now() - pending.startTime,
    };

    log.push(entry);

    // Cap at MAX_LOG_ENTRIES
    if (log.length > MAX_LOG_ENTRIES) {
      log.splice(0, log.length - MAX_LOG_ENTRIES);
    }
  });

  return page;
}

/**
 * Get captured network requests, optionally filtered.
 */
export function getNetworkLog(
  profileId: string = 'default',
  filter?: { urlPattern?: string; method?: string; statusMin?: number; statusMax?: number },
): NetworkEntry[] {
  const log = networkLogs.get(profileId) || [];

  if (!filter) return [...log];

  return log.filter((entry) => {
    if (filter.urlPattern && !new RegExp(filter.urlPattern, 'i').test(entry.url)) return false;
    if (filter.method && entry.method.toUpperCase() !== filter.method.toUpperCase()) return false;
    if (filter.statusMin && entry.status < filter.statusMin) return false;
    if (filter.statusMax && entry.status > filter.statusMax) return false;
    return true;
  });
}

/**
 * Clear the network log for a profile.
 */
export function clearNetworkLog(profileId: string = 'default'): void {
  networkLogs.set(profileId, []);
}

/**
 * Set up request interception on a page.
 * Actions: 'block' (abort request), 'modify-headers' (add/change headers), 'mock' (return fake response).
 */
export async function interceptRequests(
  page: Page,
  rules: Array<{
    urlPattern: string;
    action: 'block' | 'modify-headers' | 'mock';
    headers?: Record<string, string>;
    mockStatus?: number;
    mockBody?: string;
    mockContentType?: string;
  }>,
): Promise<void> {
  for (const rule of rules) {
    await page.route(new RegExp(rule.urlPattern, 'i'), async (route) => {
      switch (rule.action) {
        case 'block':
          await route.abort();
          break;
        case 'modify-headers':
          await route.continue({
            headers: { ...route.request().headers(), ...(rule.headers || {}) },
          });
          break;
        case 'mock':
          await route.fulfill({
            status: rule.mockStatus || 200,
            contentType: rule.mockContentType || 'application/json',
            body: rule.mockBody || '{}',
          });
          break;
        default:
          await route.continue();
      }
    });
  }
}
