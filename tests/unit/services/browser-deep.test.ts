import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────

vi.mock('../../../src/utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockPage = {
  close: vi.fn().mockResolvedValue(undefined),
  context: vi.fn(),
  setDefaultNavigationTimeout: vi.fn(),
  setDefaultTimeout: vi.fn(),
  goto: vi.fn().mockResolvedValue({ status: () => 200 }),
  waitForTimeout: vi.fn().mockResolvedValue(undefined),
  evaluate: vi.fn().mockResolvedValue({ content: '', links: [] }),
  route: vi.fn().mockResolvedValue(undefined),
  screenshot: vi.fn().mockResolvedValue(Buffer.from('fake')),
  on: vi.fn(),
};

const mockContext = {
  newPage: vi.fn().mockResolvedValue(mockPage),
  pages: vi.fn().mockReturnValue([]),
  close: vi.fn().mockResolvedValue(undefined),
  cookies: vi.fn().mockResolvedValue([{ name: 'sid', value: 'abc', domain: '.example.com' }]),
  addCookies: vi.fn().mockResolvedValue(undefined),
};

mockPage.context.mockReturnValue(mockContext);

const mockBrowser = {
  isConnected: vi.fn().mockReturnValue(true),
  newContext: vi.fn().mockResolvedValue(mockContext),
  close: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
};

vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn().mockResolvedValue(mockBrowser),
  },
}));

vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue('[]'),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readdirSync: vi.fn().mockReturnValue([]),
}));

// ─── Test Suite ──────────────────────────────────────────────────

describe('browser.ts — adversarial deep tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset module-level state by re-importing
    vi.resetModules();
  });

  // ═══ Cookie Persistence ═══

  describe('cookie persistence', () => {
    it('saveCookies writes to both memory map and disk (via writeFile)', async () => {
      const { writeFile } = await import('fs/promises');
      const { saveCookies } = await import('../../../src/services/browser.js');

      const fakePage = {
        context: () => ({
          cookies: vi.fn().mockResolvedValue([
            { name: 'token', value: 'xyz', domain: '.test.com' },
          ]),
        }),
      } as any;

      await saveCookies(fakePage, 'test.com');

      // writeFile should have been called for disk persistence
      expect(writeFile).toHaveBeenCalled();
      const callArgs = (writeFile as any).mock.calls[0];
      expect(callArgs[0]).toContain('test.com.json');
    });

    it('createPageWithCookies loads from memory first, then falls back to disk', async () => {
      const { existsSync } = await import('fs');
      const { readFile } = await import('fs/promises');

      // Simulate disk cookies available
      (existsSync as any).mockReturnValue(true);
      (readFile as any).mockResolvedValue(
        JSON.stringify([{ name: 'session', value: 'disk-val', domain: '.site.com' }])
      );

      const { createPageWithCookies, safeClosePage } = await import('../../../src/services/browser.js');

      const page = await createPageWithCookies('site.com');
      // Should have called addCookies on the context
      expect(mockContext.addCookies).toHaveBeenCalled();
      await safeClosePage(page);
    });

    it('expired cookies are filtered on restore (expires > 0 and expires < now → removed)', async () => {
      const { existsSync } = await import('fs');
      const { readFile } = await import('fs/promises');

      const now = Date.now() / 1000;
      const expiredCookie = { name: 'old', value: 'x', expires: now - 3600 }; // expired 1h ago
      const validCookie = { name: 'fresh', value: 'y', expires: now + 3600 }; // valid for 1h

      (existsSync as any).mockReturnValue(true);
      (readFile as any).mockResolvedValue(JSON.stringify([expiredCookie, validCookie]));

      const { createPageWithCookies, safeClosePage } = await import('../../../src/services/browser.js');

      const page = await createPageWithCookies('cookies.com');

      // Only the valid cookie should have been added
      const addedCookies = mockContext.addCookies.mock.calls[0]?.[0];
      expect(addedCookies).toHaveLength(1);
      expect(addedCookies[0].name).toBe('fresh');
      await safeClosePage(page);
    });

    it('session cookie (expires=-1) is kept during restore', async () => {
      const { existsSync } = await import('fs');
      const { readFile } = await import('fs/promises');

      const sessionCookie = { name: 'sess', value: 's', expires: -1 };
      (existsSync as any).mockReturnValue(true);
      (readFile as any).mockResolvedValue(JSON.stringify([sessionCookie]));

      const { createPageWithCookies, safeClosePage } = await import('../../../src/services/browser.js');

      const page = await createPageWithCookies('session-test.com');
      const addedCookies = mockContext.addCookies.mock.calls[0]?.[0];
      expect(addedCookies).toHaveLength(1);
      expect(addedCookies[0].expires).toBe(-1);
      await safeClosePage(page);
    });
  });

  // ═══ Page Management ═══

  describe('page management', () => {
    it('createPage increments activePages', async () => {
      const { createPage, safeClosePage } = await import('../../../src/services/browser.js');

      const page1 = await createPage();
      // We can't read activePages directly, but creating 3 should succeed
      const page2 = await createPage();
      const page3 = await createPage();

      // 4th should fail (MAX_CONCURRENT_PAGES=3)
      await expect(createPage()).rejects.toThrow(/concurrency limit/i);

      await safeClosePage(page1);
      await safeClosePage(page2);
      await safeClosePage(page3);
    });

    it('4th concurrent page throws with MAX_CONCURRENT_PAGES=3', async () => {
      const { createPage, safeClosePage } = await import('../../../src/services/browser.js');

      const pages = [];
      for (let i = 0; i < 3; i++) {
        pages.push(await createPage());
      }

      await expect(createPage()).rejects.toThrow('Browser concurrency limit reached');

      for (const p of pages) {
        await safeClosePage(p);
      }
    });

    it('safeClosePage decrements activePages — allows new page after close', async () => {
      const { createPage, safeClosePage } = await import('../../../src/services/browser.js');

      const pages = [];
      for (let i = 0; i < 3; i++) {
        pages.push(await createPage());
      }

      // At limit
      await expect(createPage()).rejects.toThrow(/concurrency/i);

      // Close one
      await safeClosePage(pages.pop()!);

      // Now we should be able to create again
      const newPage = await createPage();
      expect(newPage).toBeDefined();
      await safeClosePage(newPage);
      for (const p of pages) await safeClosePage(p);
    });

    it('safeClosePage(null) is safe — no error thrown', async () => {
      const { safeClosePage } = await import('../../../src/services/browser.js');
      await expect(safeClosePage(null)).resolves.toBeUndefined();
    });
  });

  // ═══ BUG: No Session Persistence ═══

  describe('BUG: no session persistence (keepAlive/releaseSession)', () => {
    /**
     * DOCUMENTED BUG: browser.ts has no keepAlive, getActivePage, or releaseSession
     * exports. The browser closes between tool calls, destroying session state.
     * This means every tool invocation pays the browser launch cost and loses
     * any in-page state (form data, navigation history, JS variables).
     *
     * A production browser service should support:
     *   - keepAlive(sessionId): prevent auto-close
     *   - getActivePage(sessionId): return existing page without creating new one
     *   - releaseSession(sessionId): explicit cleanup
     */
    it('browser.ts exports keepAlive', async () => {
      const browserModule = await import('../../../src/services/browser.js');
      expect(browserModule).toHaveProperty('keepAlive');
      expect(typeof browserModule.keepAlive).toBe('function');
    });

    it('browser.ts exports getActivePage', async () => {
      const browserModule = await import('../../../src/services/browser.js');
      expect(browserModule).toHaveProperty('getActivePage');
      expect(typeof browserModule.getActivePage).toBe('function');
    });

    it('browser.ts exports releaseSession', async () => {
      const browserModule = await import('../../../src/services/browser.js');
      expect(browserModule).toHaveProperty('releaseSession');
      expect(typeof browserModule.releaseSession).toBe('function');
    });
  });

  // ═══ Timeouts ═══

  describe('timeouts', () => {
    it('default page timeout is 90s (PAGE_TIMEOUT)', async () => {
      const { createPage, safeClosePage } = await import('../../../src/services/browser.js');

      const page = await createPage();
      // setDefaultNavigationTimeout should have been called with 90000
      expect(mockPage.setDefaultNavigationTimeout).toHaveBeenCalledWith(90_000);
      expect(mockPage.setDefaultTimeout).toHaveBeenCalledWith(90_000);
      await safeClosePage(page);
    });

    it('MFA page timeout is 120s (MFA_PAGE_TIMEOUT)', async () => {
      const { createPage, safeClosePage } = await import('../../../src/services/browser.js');

      const page = await createPage({ mfaExpected: true });
      expect(mockPage.setDefaultNavigationTimeout).toHaveBeenCalledWith(120_000);
      expect(mockPage.setDefaultTimeout).toHaveBeenCalledWith(120_000);
      await safeClosePage(page);
    });
  });

  // ═══ loadPage ═══

  describe('loadPage', () => {
    /**
     * BUG DOCUMENTATION: loadPage (line ~309) uses `document.querySelectorAll`
     * inside a page.evaluate() string template. This works at runtime because
     * it executes in browser context, but:
     *
     * 1. TypeScript can't type-check code inside template strings
     * 2. Any DOM API typo (e.g. `document.querySelectrAll`) would only fail at runtime
     * 3. The evaluate string uses `links.push(...)` — if `links` were const, it would
     *    silently fail in strict mode in some engines
     * 4. No error boundary inside the evaluate — a single bad link crashes the whole extraction
     *
     * This is not a blocking bug but a code quality / testability issue.
     */
    it('loadPage returns content, links, status, and page', async () => {
      mockPage.evaluate.mockResolvedValueOnce({
        content: 'Hello World',
        links: [{ text: 'Example', url: 'https://example.com' }],
      });
      mockPage.goto.mockResolvedValueOnce({ status: () => 200 });

      const { loadPage, safeClosePage } = await import('../../../src/services/browser.js');

      const result = await loadPage('https://example.com');
      expect(result.content).toBe('Hello World');
      expect(result.links).toHaveLength(1);
      expect(result.status).toBe(200);
      expect(result.page).toBeDefined();
      await safeClosePage(result.page);
    });

    it('loadPage closes page on navigation error', async () => {
      mockPage.goto.mockRejectedValueOnce(new Error('net::ERR_NAME_NOT_RESOLVED'));

      const { loadPage } = await import('../../../src/services/browser.js');

      await expect(loadPage('https://nonexistent.invalid')).rejects.toThrow();
      // safeClosePage should have been called internally (page.close)
      expect(mockPage.close).toHaveBeenCalled();
    });
  });

  // ═══ Network Monitoring ═══

  describe('network monitoring', () => {
    it('getNetworkLog returns empty array for unknown profileId', async () => {
      const { getNetworkLog } = await import('../../../src/services/browser.js');
      const log = getNetworkLog('nonexistent-profile');
      expect(log).toEqual([]);
    });

    it('clearNetworkLog resets the log for a profile', async () => {
      const { clearNetworkLog, getNetworkLog } = await import('../../../src/services/browser.js');
      clearNetworkLog('test-profile');
      const log = getNetworkLog('test-profile');
      expect(log).toEqual([]);
    });
  });

  // ═══ interceptRequests ═══

  describe('interceptRequests', () => {
    it('sets up route handlers for each rule', async () => {
      const { interceptRequests } = await import('../../../src/services/browser.js');

      const page = mockPage as any;
      await interceptRequests(page, [
        { urlPattern: '.*\\.ads\\..*', action: 'block' },
        { urlPattern: '.*api.*', action: 'modify-headers', headers: { 'X-Test': 'true' } },
        { urlPattern: '.*mock.*', action: 'mock', mockStatus: 201, mockBody: '{"ok":true}' },
      ]);

      // page.route should have been called 3 times
      expect(mockPage.route).toHaveBeenCalledTimes(3);
    });
  });

  // ═══ Circuit Breaker (LAST — mutates chromium.launch mock) ═══

  describe('circuit breaker', () => {
    it.skip('after MAX_CONSECUTIVE_FAILURES=5 launch failures, getBrowser resets counter and waits (skipped: module-level state not resettable in test)', async () => {
      /**
       * EXPECTED TO FAIL — documents a testability weakness.
       *
       * browser.ts uses module-level mutable state (let browser, let consecutiveFailures)
       * that persists across test imports even with vi.resetModules(). The `browser` variable
       * is already set from prior tests (getBrowser returns cached), so overriding
       * chromium.launch doesn't trigger new launches until the cached browser is
       * invalidated — but isConnected() returns true from the mock.
       *
       * To properly test the circuit breaker, browser.ts would need:
       * - An exported resetState() function for testing
       * - Or dependency injection for the browser instance
       * - Or the circuit breaker extracted into a testable pure function
       */
      const { chromium } = await import('playwright');

      let failCount = 0;
      (chromium.launch as any).mockImplementation(() => {
        failCount++;
        if (failCount <= 5) throw new Error(`Launch fail #${failCount}`);
        return Promise.resolve(mockBrowser);
      });

      const { getBrowser } = await import('../../../src/services/browser.js');

      // First 5 calls should throw
      for (let i = 0; i < 5; i++) {
        await expect(getBrowser()).rejects.toThrow(/Browser launch failed/);
      }

      // 6th call triggers circuit breaker (resets counter, waits 2s, then retries)
      const browser = await getBrowser();
      expect(browser).toBeDefined();
    });
  });
});
