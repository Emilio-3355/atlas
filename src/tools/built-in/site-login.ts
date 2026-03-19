import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { createPageWithCookies, safeClosePage, saveCookies } from '../../services/browser.js';
import { query } from '../../config/database.js';
import { tagContent } from '../../security/content-trust.js';
import logger from '../../utils/logger.js';

// ===== Known site configs (shortcuts — but generic login works for any URL) =====

interface SiteConfig {
  name: string;
  loginUrl: string;
  postLoginUrl?: string;
}

const KNOWN_SITES: Record<string, SiteConfig> = {
  vergil: {
    name: 'Vergil (Columbia)',
    loginUrl: 'https://cas.columbia.edu/cas/login?service=https%3A%2F%2Fvergil.registrar.columbia.edu%2F',
    postLoginUrl: 'https://vergil.registrar.columbia.edu/',
  },
  courseworks: {
    name: 'Courseworks (Columbia Canvas)',
    loginUrl: 'https://courseworks2.columbia.edu/login/saml',
  },
  lionmail: {
    name: 'LionMail (Columbia Gmail)',
    loginUrl: 'https://cas.columbia.edu/cas/login?service=https%3A%2F%2Fmail.google.com%2Fa%2Fcolumbia.edu',
  },
};

// ===== Credential storage =====

async function storeCredentials(site: string, username: string, password: string): Promise<void> {
  await query(
    `INSERT INTO memory_facts (category, key, value, source, confidence, metadata)
     VALUES ('site_credentials', $1, $2, 'jp_provided', 1.0, $3)
     ON CONFLICT (category, key)
     DO UPDATE SET value = $2, metadata = $3, updated_at = NOW()`,
    [site, username, JSON.stringify({ stored_at: new Date().toISOString() })]
  );
  await query(
    `INSERT INTO memory_facts (category, key, value, source, confidence, metadata)
     VALUES ('site_credentials_secret', $1, $2, 'jp_provided', 1.0, '{}')
     ON CONFLICT (category, key)
     DO UPDATE SET value = $2, updated_at = NOW()`,
    [site, password]
  );
}

async function getCredentials(site: string): Promise<{ username: string; password: string } | null> {
  const [userResult, passResult] = await Promise.all([
    query(`SELECT value FROM memory_facts WHERE category = 'site_credentials' AND key = $1`, [site]),
    query(`SELECT value FROM memory_facts WHERE category = 'site_credentials_secret' AND key = $1`, [site]),
  ]);
  if (userResult.rows.length === 0 || passResult.rows.length === 0) return null;
  return { username: userResult.rows[0].value, password: passResult.rows[0].value };
}

// ===== Generic login engine =====

/**
 * Auto-detect and fill a login form on ANY page.
 * Finds username/email and password fields by type, name, id, placeholder, label.
 * Works for CAS, Google, standard forms, etc.
 */
async function autoFillLoginForm(
  page: any,
  username: string,
  password: string,
): Promise<{ filled: boolean; error?: string }> {
  try {
    // Wait for the page to be interactive
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // Check all frames (main + iframes like Duo)
    const frames = [page, ...page.frames()];

    for (const frame of frames) {
      try {
        // Find username/email field
        const usernameSelectors = [
          'input[type="text"][name*="user" i]',
          'input[type="text"][name*="email" i]',
          'input[type="text"][id*="user" i]',
          'input[type="text"][id*="email" i]',
          'input[type="email"]',
          'input[name="username"]',
          'input[name="login"]',
          'input[id="username"]',
          'input[id="login"]',
          'input[type="text"][placeholder*="user" i]',
          'input[type="text"][placeholder*="email" i]',
          'input[type="text"][autocomplete="username"]',
          // Catch-all: first visible text input
          'input[type="text"]:visible',
        ];

        const passwordSelectors = [
          'input[type="password"]',
          'input[name="password"]',
          'input[id="password"]',
        ];

        let usernameField = null;
        let passwordField = null;

        // Find username field
        for (const sel of usernameSelectors) {
          try {
            const el = await frame.$(sel);
            if (el && await el.isVisible()) {
              usernameField = el;
              logger.info('Found username field', { selector: sel });
              break;
            }
          } catch { /* skip */ }
        }

        // Find password field
        for (const sel of passwordSelectors) {
          try {
            const el = await frame.$(sel);
            if (el && await el.isVisible()) {
              passwordField = el;
              logger.info('Found password field', { selector: sel });
              break;
            }
          } catch { /* skip */ }
        }

        if (usernameField && passwordField) {
          await usernameField.fill(username);
          await passwordField.fill(password);

          // Find and click submit
          const submitSelectors = [
            'button[type="submit"]',
            'input[type="submit"]',
            'button:has-text("Log in")',
            'button:has-text("Login")',
            'button:has-text("Sign in")',
            'button:has-text("Submit")',
            'button:has-text("Iniciar")',
            '#submit',
            '.login-button',
            '.submit-button',
          ];

          for (const sel of submitSelectors) {
            try {
              const btn = await frame.$(sel);
              if (btn && await btn.isVisible()) {
                await btn.click();
                logger.info('Clicked submit', { selector: sel });
                return { filled: true };
              }
            } catch { /* skip */ }
          }

          // No submit button found — try pressing Enter
          await passwordField.press('Enter');
          logger.info('No submit button found, pressed Enter');
          return { filled: true };
        }

        // Maybe it's a two-step login (username first, then password)
        if (usernameField && !passwordField) {
          await usernameField.fill(username);
          // Try submitting / pressing next
          const nextSelectors = [
            'button:has-text("Next")',
            'button:has-text("Continue")',
            'button:has-text("Siguiente")',
            'button[type="submit"]',
            'input[type="submit"]',
          ];
          for (const sel of nextSelectors) {
            try {
              const btn = await frame.$(sel);
              if (btn && await btn.isVisible()) {
                await btn.click();
                break;
              }
            } catch { /* skip */ }
          }
          // Wait for password page
          await page.waitForTimeout(2000);

          // Now look for password field again
          for (const sel of passwordSelectors) {
            try {
              const el = await frame.$(sel);
              if (el && await el.isVisible()) {
                await el.fill(password);
                await el.press('Enter');
                logger.info('Two-step login: filled password');
                return { filled: true };
              }
            } catch { /* skip */ }
          }
        }
      } catch {
        // Try next frame
      }
    }

    return { filled: false, error: 'Could not find login form fields on the page' };
  } catch (err) {
    return { filled: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ===== Tool definition =====

export const siteLoginTool: ToolDefinition = {
  name: 'site_login',
  description: `Log into any website and extract content after authentication. Known shortcuts: vergil, courseworks, lionmail. Also works with any URL — just provide login_url. Actions: login (log in and get content), store_credentials (save credentials), list_sites (show saved sites).`,
  category: 'action',
  requiresApproval: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['login', 'store_credentials', 'list_sites'],
        description: 'Action to perform',
      },
      site: {
        type: 'string',
        description: 'Site identifier (vergil, courseworks, lionmail) or any name to store credentials under',
      },
      login_url: {
        type: 'string',
        description: 'Login page URL. Required for non-known sites. Overrides known site URL if provided.',
      },
      username: { type: 'string', description: 'Username (for store_credentials)' },
      password: { type: 'string', description: 'Password (for store_credentials)' },
      target_url: { type: 'string', description: 'URL to navigate to after login' },
    },
    required: ['action'],
  },
  enabled: true,
  builtIn: true,

  async execute(
    input: {
      action: string;
      site?: string;
      login_url?: string;
      username?: string;
      password?: string;
      target_url?: string;
    },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    try {
      // === LIST SITES ===
      if (input.action === 'list_sites') {
        const sites = Object.entries(KNOWN_SITES).map(([id, config]) => ({
          id, name: config.name, loginUrl: config.loginUrl,
        }));
        for (const site of sites) {
          (site as any).hasCredentials = !!(await getCredentials(site.id));
        }
        // Also list custom stored credentials
        const custom = await query(
          `SELECT key FROM memory_facts WHERE category = 'site_credentials' AND key NOT IN ('vergil','courseworks','lionmail')`
        );
        for (const row of custom.rows) {
          sites.push({ id: row.key, name: row.key, loginUrl: 'custom', hasCredentials: true } as any);
        }
        return { success: true, data: { sites } };
      }

      // === STORE CREDENTIALS ===
      if (input.action === 'store_credentials') {
        if (!input.site || !input.username || !input.password) {
          return { success: false, error: 'site, username, and password are required' };
        }
        await storeCredentials(input.site.toLowerCase(), input.username, input.password);
        return { success: true, data: { message: `Credentials saved for ${input.site}. Ready to login.` } };
      }

      // === LOGIN ===
      if (input.action === 'login') {
        if (!input.site && !input.login_url) {
          return { success: false, error: 'Provide site name or login_url' };
        }

        const siteId = (input.site || 'custom').toLowerCase();
        const knownSite = KNOWN_SITES[siteId];
        const loginUrl = input.login_url || knownSite?.loginUrl;

        if (!loginUrl) {
          return { success: false, error: `Unknown site "${siteId}" and no login_url provided. Available: ${Object.keys(KNOWN_SITES).join(', ')}` };
        }

        // Get credentials
        const creds = await getCredentials(siteId);
        if (!creds) {
          return { success: false, error: `No credentials stored for "${siteId}". Use store_credentials first.` };
        }

        // Use persistent cookies — avoids Duo re-prompts for Columbia
        const cookieDomain = siteId.includes('columbia') || ['vergil', 'courseworks', 'lionmail'].includes(siteId) ? 'columbia' : siteId;
        const page = await createPageWithCookies(cookieDomain);

        try {
          // Navigate to login page
          logger.info('site_login: navigating', { site: siteId, url: loginUrl });
          await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await page.waitForTimeout(2000);

          // Auto-detect and fill the login form
          const fillResult = await autoFillLoginForm(page, creds.username, creds.password);

          if (!fillResult.filled) {
            // Take screenshot for debugging
            const screenshotBuf = await page.screenshot({ type: 'png' }).catch(() => null);
            await safeClosePage(page);
            return {
              success: false,
              error: `Could not find login form on ${loginUrl}. ${fillResult.error || 'No username/password fields detected.'}`,
            };
          }

          // Wait for navigation after submit
          await page.waitForTimeout(4000);

          let currentUrl = page.url();
          let pageText = await page.evaluate('(document.body?.innerText || "").slice(0, 3000)') as string;

          // Check for wrong credentials
          const loginFailed = pageText.toLowerCase().includes('login incorrect') ||
            pageText.toLowerCase().includes('invalid credentials') ||
            pageText.toLowerCase().includes('invalid password') ||
            pageText.toLowerCase().includes('authentication failed') ||
            pageText.toLowerCase().includes('wrong password') ||
            pageText.toLowerCase().includes('incorrect username');

          if (loginFailed) {
            await safeClosePage(page);
            return { success: false, error: 'Login failed — wrong credentials.' };
          }

          // Check for MFA (Duo, TOTP, etc.)
          const isMfaPage = currentUrl.includes('duo') ||
            pageText.toLowerCase().includes('two-factor') ||
            pageText.toLowerCase().includes('verification code') ||
            pageText.toLowerCase().includes('push notification') ||
            pageText.toLowerCase().includes('send me a push') ||
            pageText.toLowerCase().includes('authenticator');

          if (isMfaPage) {
            logger.info('site_login: MFA detected, attempting auto-push');

            // Try clicking Duo push buttons (check frames too)
            const allFrames = [page, ...page.frames()];
            for (const frame of allFrames) {
              try {
                const pushBtns = [
                  'button:has-text("Send Me a Push")',
                  'button:has-text("Send Push")',
                  'button:has-text("Duo Push")',
                  '#duo-push',
                  '.push-label',
                  'button[data-testid="push-button"]',
                ];
                for (const sel of pushBtns) {
                  const btn = await frame.$(sel);
                  if (btn && await btn.isVisible().catch(() => false)) {
                    await btn.click();
                    logger.info('site_login: Duo push button clicked', { selector: sel });
                    break;
                  }
                }
              } catch { /* try next frame */ }
            }

            // Wait up to 65 seconds for MFA approval
            let approved = false;
            const duoStartUrl = currentUrl;
            for (let i = 0; i < 22; i++) {
              await page.waitForTimeout(3000);
              currentUrl = page.url();

              // Check if we're past MFA — URL changed to something that's NOT the Duo/CAS page
              const stillOnDuo = currentUrl.includes('duosecurity.com') ||
                currentUrl.includes('duo.columbia.edu') ||
                currentUrl === duoStartUrl;
              const stillOnCas = currentUrl.includes('cas.columbia.edu/cas/login');

              if (!stillOnDuo && !stillOnCas && currentUrl !== loginUrl) {
                approved = true;
                break;
              }

              // Also check if a known success indicator matches
              if (knownSite?.postLoginUrl && currentUrl.includes(new URL(knownSite.postLoginUrl).hostname)) {
                approved = true;
                break;
              }

              // Check page content for success indicators
              const bodyText = await page.evaluate('(document.body?.innerText || "").slice(0, 1000)').catch(() => '');
              if (typeof bodyText === 'string' && (bodyText.includes('Success') || bodyText.includes('Authenticated') || bodyText.includes('Welcome'))) {
                approved = true;
                break;
              }
            }

            if (!approved) {
              // Save cookies even on timeout — partial session might help next time
              await saveCookies(page, cookieDomain);
              await safeClosePage(page);
              return { success: false, error: 'MFA timeout (65s). Approve the Duo push on your phone and try again. Tell JP: check your Duo Mobile app.' };
            }

            // Try to click "Remember this browser" / "Yes, trust browser" after Duo
            try {
              const trustSelectors = [
                'button:has-text("Yes, trust browser")',
                'button:has-text("Remember")',
                'input[name="dampen_choice"][value="true"]',
                '#trust-browser-button',
                'button:has-text("Trust")',
              ];
              for (const sel of trustSelectors) {
                const btn = await page.$(sel);
                if (btn && await btn.isVisible().catch(() => false)) {
                  await btn.click();
                  logger.info('Clicked "trust browser" after Duo');
                  await page.waitForTimeout(2000);
                  break;
                }
              }
            } catch { /* non-critical */ }
          }

          // Navigate to target if specified
          const targetUrl = input.target_url || knownSite?.postLoginUrl;
          if (targetUrl && !currentUrl.includes(new URL(targetUrl).hostname)) {
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await page.waitForTimeout(2000);
          }

          // Extract page content and links
          const content = await page.evaluate(`
            (() => {
              ['script','style','iframe','noscript'].forEach(s =>
                document.querySelectorAll(s).forEach(el => el.remove())
              );
              return (document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 15000);
            })()
          `) as string;

          const links = await page.evaluate(`
            (() => {
              const links = [], seen = new Set();
              document.querySelectorAll('a[href]').forEach(a => {
                const href = a.getAttribute('href') || '';
                const text = (a.textContent || '').trim().slice(0, 100);
                if (!href || !text || text.length < 2) return;
                let url; try { url = new URL(href, location.href).href; } catch { return; }
                if (seen.has(url) || url.startsWith('javascript:')) return;
                seen.add(url);
                links.push({ text, url });
              });
              return links.slice(0, 30);
            })()
          `) as Array<{ text: string; url: string }>;

          const finalUrl = page.url();

          // Save cookies so Duo doesn't prompt next time
          await saveCookies(page, cookieDomain);

          await safeClosePage(page);

          return {
            success: true,
            data: {
              loggedIn: true,
              site: knownSite?.name || siteId,
              url: finalUrl,
              content: tagContent(content, 'untrusted', finalUrl),
              links: links.slice(0, 20),
              linksSummary: links.slice(0, 15).map(l => `  "${l.text}" → ${l.url}`).join('\n'),
            },
          };
        } catch (err) {
          await safeClosePage(page);
          throw err;
        }
      }

      return { success: false, error: `Unknown action: ${input.action}` };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error('site_login error', { error: errMsg, site: input.site });
      return { success: false, error: errMsg };
    }
  },
};
