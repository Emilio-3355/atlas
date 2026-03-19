import { chromium, type Browser, type Page, type BrowserContext } from 'playwright';
import logger from '../utils/logger.js';

let browser: Browser | null = null;
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 5;
const PAGE_TIMEOUT = 45_000;      // 45s for page navigation
const SCREENSHOT_TIMEOUT = 30_000; // 30s for screenshots

// ─── Browser Lifecycle ──────────────────────────────────────────

export async function getBrowser(): Promise<Browser> {
  // If browser exists and is connected, reuse it
  if (browser) {
    try {
      if (browser.isConnected()) {
        return browser;
      }
    } catch {
      // isConnected() itself threw — browser is dead
    }
    // Browser is disconnected — clean up
    logger.warn('Browser disconnected, relaunching');
    try { await browser.close(); } catch {}
    browser = null;
  }

  // Circuit breaker: if we've failed too many times, wait before retrying
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    const msg = `Browser circuit breaker open: ${consecutiveFailures} consecutive launch failures. Resetting.`;
    logger.error(msg);
    consecutiveFailures = 0; // Reset so next attempt tries fresh
    // Small delay to avoid rapid-fire relaunches
    await new Promise(r => setTimeout(r, 2000));
  }

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--single-process',         // More stable in containers
      ],
    });

    // Auto-recover on unexpected disconnect
    browser.on('disconnected', () => {
      logger.warn('Browser disconnected unexpectedly');
      browser = null;
    });

    consecutiveFailures = 0;
    logger.info('Playwright browser launched');
    return browser;
  } catch (err) {
    consecutiveFailures++;
    browser = null;
    logger.error('Failed to launch browser', { error: err, failures: consecutiveFailures });
    throw new Error(`Browser launch failed (attempt ${consecutiveFailures}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function createPage(): Promise<Page> {
  const b = await getBrowser();

  let context: BrowserContext;
  try {
    context = await b.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });
  } catch (err) {
    // Context creation failed — browser is likely dead
    logger.error('Failed to create browser context, killing browser', { error: err });
    await killBrowser();
    // Retry once with a fresh browser
    const fresh = await getBrowser();
    context = await fresh.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });
  }

  const page = await context.newPage();

  // Default navigation timeout for all goto calls on this page
  page.setDefaultNavigationTimeout(PAGE_TIMEOUT);
  page.setDefaultTimeout(PAGE_TIMEOUT);

  return page;
}

/** Safely close a page and its context, ignoring errors */
export async function safeClosePage(page: Page | null): Promise<void> {
  if (!page) return;
  try {
    const ctx = page.context();
    await page.close().catch(() => {});
    await ctx.close().catch(() => {});
  } catch {}
}

/** Force-kill the browser and reset state */
async function killBrowser(): Promise<void> {
  if (browser) {
    try { await browser.close(); } catch {}
    browser = null;
  }
}

// ─── Page Loading ───────────────────────────────────────────────

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
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: PAGE_TIMEOUT,
    });
    const status = response?.status() ?? 0;
    await page.waitForTimeout(waitMs);

    const extracted = await page.evaluate(`
      (() => {
        const links = [];
        const seen = new Set();
        document.querySelectorAll('a[href]').forEach(a => {
          const href = a.getAttribute('href') || '';
          const text = (a.textContent || '').trim().slice(0, 100);
          if (!href || !text || text.length < 2) return;
          let fullUrl;
          try { fullUrl = new URL(href, document.location.href).href; } catch { return; }
          if (seen.has(fullUrl)) return;
          if (fullUrl.startsWith('javascript:') || fullUrl.startsWith('mailto:') || fullUrl.startsWith('#')) return;
          seen.add(fullUrl);
          links.push({ text, url: fullUrl });
        });

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
    await safeClosePage(page);
    throw err;
  }
}

export async function takeScreenshot(url: string): Promise<Buffer> {
  const page = await createPage();

  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: SCREENSHOT_TIMEOUT,
    });
    await page.waitForTimeout(2000);
    const screenshot = await page.screenshot({ type: 'png', fullPage: false });
    return screenshot;
  } finally {
    await safeClosePage(page);
  }
}

export async function closeBrowser(): Promise<void> {
  await killBrowser();
  logger.info('Browser closed');
}

// ─── Network Monitoring ─────────────────────────────────────────

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
    if (log.length > MAX_LOG_ENTRIES) {
      log.splice(0, log.length - MAX_LOG_ENTRIES);
    }
  });

  return page;
}

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

export function clearNetworkLog(profileId: string = 'default'): void {
  networkLogs.set(profileId, []);
}

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
