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

export async function loadPage(url: string, waitMs: number = 3000): Promise<{ page: Page; content: string }> {
  const page = await createPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(waitMs);

    // Extract readable text (runs in browser context)
    const content = await page.evaluate(`
      (() => {
        const removeSelectors = ['script', 'style', 'nav', 'footer', 'header', 'iframe', 'noscript'];
        for (const sel of removeSelectors) {
          document.querySelectorAll(sel).forEach(el => el.remove());
        }
        const body = document.body;
        if (!body) return '';
        return body.innerText.replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 10000);
      })()
    `) as string;

    return { page, content };
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
