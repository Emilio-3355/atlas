import { chromium, type Browser, type Page, type BrowserContext } from 'playwright';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import logger from '../utils/logger.js';

let browser: Browser | null = null;
let consecutiveFailures = 0;
let activePages = 0;
let browserLock: Promise<Browser> | null = null; // Prevent concurrent launches

// Persistent cookie storage — survives across page sessions AND process restarts
let storedCookies: Map<string, any[]> = new Map();
const COOKIE_DIR = process.env.COOKIE_DIR || '/tmp/atlas-cookies';
const MAX_CONSECUTIVE_FAILURES = 5;
const MAX_CONCURRENT_PAGES = 3;   // Prevent OOM from too many pages
const PAGE_TIMEOUT = 90_000;      // 90s for page navigation (Duo MFA needs 66s+)
const MFA_PAGE_TIMEOUT = 120_000; // 2min for pages that will go through MFA
const SCREENSHOT_TIMEOUT = 30_000; // 30s for screenshots

// ─── Cookie Persistence (to disk) ────────────────────────────────

async function ensureCookieDir(): Promise<void> {
  if (!existsSync(COOKIE_DIR)) {
    await mkdir(COOKIE_DIR, { recursive: true });
  }
}

async function persistCookiesToDisk(domain: string, cookies: any[]): Promise<void> {
  try {
    await ensureCookieDir();
    const filePath = path.join(COOKIE_DIR, `${domain}.json`);
    await writeFile(filePath, JSON.stringify(cookies, null, 2));
    logger.debug('Cookies persisted to disk', { domain, count: cookies.length });
  } catch (err) {
    logger.debug('Failed to persist cookies to disk', { error: err });
  }
}

async function loadCookiesFromDisk(domain: string): Promise<any[] | null> {
  try {
    const filePath = path.join(COOKIE_DIR, `${domain}.json`);
    if (!existsSync(filePath)) return null;
    const data = await readFile(filePath, 'utf-8');
    const cookies = JSON.parse(data);
    if (Array.isArray(cookies) && cookies.length > 0) {
      logger.debug('Cookies loaded from disk', { domain, count: cookies.length });
      return cookies;
    }
    return null;
  } catch (err) {
    logger.debug('Failed to load cookies from disk', { error: err });
    return null;
  }
}

// Load cookies from disk on startup
async function initCookies(): Promise<void> {
  try {
    await ensureCookieDir();
    const { readdirSync } = await import('fs');
    const files = readdirSync(COOKIE_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const domain = file.replace('.json', '');
      const cookies = await loadCookiesFromDisk(domain);
      if (cookies) {
        storedCookies.set(domain, cookies);
      }
    }
    if (storedCookies.size > 0) {
      logger.info('Restored cookies from disk', { domains: Array.from(storedCookies.keys()) });
    }
  } catch (err) {
    logger.debug('Cookie init skipped', { error: err });
  }
}

// Initialize cookies on module load
initCookies().catch(() => {});

// Modern User-Agent — matches real Chrome to avoid bot detection
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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

  // Prevent concurrent launches — serialize browser creation
  if (browserLock) {
    return browserLock;
  }

  browserLock = (async () => {
    // Circuit breaker: if we've failed too many times, wait before retrying
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      const msg = `Browser circuit breaker open: ${consecutiveFailures} consecutive launch failures. Resetting.`;
      logger.error(msg);
      consecutiveFailures = 0;
      await new Promise(r => setTimeout(r, 2000));
    }

    try {
      const b = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-software-rasterizer',
          '--disable-translate',
          '--disable-sync',
          '--disable-default-apps',
          '--no-first-run',
          '--no-zygote',
          '--disable-blink-features=AutomationControlled', // Avoid bot detection
          '--js-flags=--max-old-space-size=512', // 512MB heap — 256 was too tight for MFA
        ],
      });

      b.on('disconnected', () => {
        logger.warn('Browser disconnected unexpectedly');
        browser = null;
      });

      browser = b;
      consecutiveFailures = 0;
      logger.info('Playwright browser launched');
      return b;
    } catch (err) {
      consecutiveFailures++;
      browser = null;
      logger.error('Failed to launch browser', { error: err, failures: consecutiveFailures });
      throw new Error(`Browser launch failed (attempt ${consecutiveFailures}): ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      browserLock = null;
    }
  })();

  return browserLock;
}

export async function createPage(opts?: { mfaExpected?: boolean }): Promise<Page> {
  // Atomic concurrency check — increment first, decrement on failure
  activePages++;
  if (activePages > MAX_CONCURRENT_PAGES) {
    activePages--;
    throw new Error(`Browser concurrency limit reached (${MAX_CONCURRENT_PAGES} pages). Wait for current pages to close.`);
  }

  const timeout = opts?.mfaExpected ? MFA_PAGE_TIMEOUT : PAGE_TIMEOUT;

  const b = await getBrowser();

  let context: BrowserContext;
  const contextOpts = {
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    javaScriptEnabled: true,
  };

  try {
    context = await b.newContext(contextOpts);
  } catch (err) {
    logger.error('Failed to create browser context, killing browser', { error: err });
    activePages--;
    await killBrowser();
    // Retry once with a fresh browser
    activePages++;
    const fresh = await getBrowser();
    context = await fresh.newContext(contextOpts);
  }

  let page: Page;
  try {
    page = await context.newPage();
  } catch (err) {
    activePages--;
    throw err;
  }

  // Set timeouts based on whether MFA is expected
  page.setDefaultNavigationTimeout(timeout);
  page.setDefaultTimeout(timeout);

  return page;
}

/** Save cookies from a page's context for a specific domain group — persists to disk */
export async function saveCookies(page: Page, domain: string): Promise<void> {
  try {
    const ctx = page.context();
    const cookies = await ctx.cookies();
    if (cookies.length > 0) {
      storedCookies.set(domain, cookies);
      // Persist to disk so cookies survive process restarts
      await persistCookiesToDisk(domain, cookies);
      logger.info('Saved browser cookies (memory + disk)', { domain, count: cookies.length });
    }
  } catch (err) {
    logger.debug('Failed to save cookies', { error: err });
  }
}

/** Create a page with restored cookies for a domain (checks disk if not in memory) */
export async function createPageWithCookies(domain: string, opts?: { mfaExpected?: boolean }): Promise<Page> {
  const page = await createPage(opts);

  // Try memory first, then disk
  let cookies = storedCookies.get(domain);
  if (!cookies || cookies.length === 0) {
    cookies = await loadCookiesFromDisk(domain) || undefined;
    if (cookies) {
      storedCookies.set(domain, cookies); // Cache in memory
    }
  }

  if (cookies && cookies.length > 0) {
    try {
      // Filter out expired cookies before restoring
      const now = Date.now() / 1000;
      const validCookies = cookies.filter((c: any) => !c.expires || c.expires === -1 || c.expires > now);
      if (validCookies.length > 0) {
        await page.context().addCookies(validCookies);
        logger.info('Restored browser cookies', { domain, count: validCookies.length, expired: cookies.length - validCookies.length });
      }
    } catch (err) {
      logger.warn('Failed to restore cookies — continuing without them', { error: err, domain });
    }
  }
  return page;
}

/** Safely close a page (NOT its context — other pages may share it) */
export async function safeClosePage(page: Page | null): Promise<void> {
  if (!page) return;
  try {
    // Close just the page, then close the context only if it has no other pages
    const ctx = page.context();
    await page.close().catch(() => {});
    // Check if context has other open pages before closing it
    const remainingPages = ctx.pages();
    if (remainingPages.length === 0) {
      await ctx.close().catch(() => {});
    }
  } catch {}
  activePages = Math.max(0, activePages - 1);
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
    // Block heavy resources to save memory and speed up loading
    await page.route('**/*.{png,jpg,jpeg,gif,svg,webp,ico,woff,woff2,ttf,eot}', route => route.abort());
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['media', 'font', 'image'].includes(type)) return route.abort();
      return route.continue();
    });

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
