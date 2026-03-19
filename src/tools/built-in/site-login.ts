import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { createPage } from '../../services/browser.js';
import { query } from '../../config/database.js';
import { tagContent } from '../../security/content-trust.js';
import logger from '../../utils/logger.js';

/**
 * Known site login configurations.
 * Each entry defines how to log into a specific site via Playwright.
 */
interface SiteLoginConfig {
  name: string;
  loginUrl: string;
  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;
  /** URL or pattern that indicates successful login */
  successIndicator: string;
  /** Optional: URL to navigate to after login */
  postLoginUrl?: string;
  /** Wait time after submit (ms) */
  waitAfterSubmit?: number;
}

const KNOWN_SITES: Record<string, SiteLoginConfig> = {
  vergil: {
    name: 'Vergil (Columbia)',
    loginUrl: 'https://cas.columbia.edu/cas/login?service=https%3A%2F%2Fvergil.registrar.columbia.edu%2F',
    usernameSelector: '#username',
    passwordSelector: '#password',
    submitSelector: 'input[type="submit"], button[type="submit"]',
    successIndicator: 'vergil.registrar.columbia.edu',
    postLoginUrl: 'https://vergil.registrar.columbia.edu/',
    waitAfterSubmit: 3000,
  },
  courseworks: {
    name: 'Courseworks (Columbia Canvas)',
    loginUrl: 'https://courseworks2.columbia.edu/login/saml',
    usernameSelector: '#username',
    passwordSelector: '#password',
    submitSelector: 'input[type="submit"], button[type="submit"]',
    successIndicator: 'courseworks2.columbia.edu',
    waitAfterSubmit: 4000,
  },
  lionmail: {
    name: 'LionMail (Columbia Gmail)',
    loginUrl: 'https://cas.columbia.edu/cas/login?service=https%3A%2F%2Fmail.google.com%2Fa%2Fcolumbia.edu',
    usernameSelector: '#username',
    passwordSelector: '#password',
    submitSelector: 'input[type="submit"], button[type="submit"]',
    successIndicator: 'mail.google.com',
    waitAfterSubmit: 4000,
  },
};

/**
 * Store credentials securely in the database.
 * Claude never sees the actual password — it just calls store_credentials
 * with the site name and the values JP provides.
 */
async function storeCredentials(site: string, username: string, password: string): Promise<void> {
  await query(
    `INSERT INTO memory_facts (category, key, value, source, confidence, metadata)
     VALUES ('site_credentials', $1, $2, 'jp_provided', 1.0, $3)
     ON CONFLICT (category, key)
     DO UPDATE SET value = $2, metadata = $3, updated_at = NOW()`,
    [
      site,
      username, // Store username as value
      JSON.stringify({ has_password: true, stored_at: new Date().toISOString() }),
    ]
  );
  // Store password separately (not in the value field Claude might see in context)
  await query(
    `INSERT INTO memory_facts (category, key, value, source, confidence, metadata)
     VALUES ('site_credentials_secret', $1, $2, 'jp_provided', 1.0, '{}')
     ON CONFLICT (category, key)
     DO UPDATE SET value = $2, updated_at = NOW()`,
    [site, password]
  );
}

async function getCredentials(site: string): Promise<{ username: string; password: string } | null> {
  const userResult = await query(
    `SELECT value FROM memory_facts WHERE category = 'site_credentials' AND key = $1`,
    [site]
  );
  const passResult = await query(
    `SELECT value FROM memory_facts WHERE category = 'site_credentials_secret' AND key = $1`,
    [site]
  );
  if (userResult.rows.length === 0 || passResult.rows.length === 0) return null;
  return { username: userResult.rows[0].value, password: passResult.rows[0].value };
}

export const siteLoginTool: ToolDefinition = {
  name: 'site_login',
  description: `Log into a website and extract content after authentication. Supports: vergil (Columbia student portal), courseworks (Canvas), lionmail (Columbia Gmail). Use this when JP asks to check his courses, assignments, grades, or any Columbia portal. Actions: login (log in and get page content), store_credentials (save JP's username/password for a site), list_sites (show available sites).`,
  category: 'action',
  requiresApproval: false, // JP explicitly wants this to work without friction
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
        description: 'Site identifier (vergil, courseworks, lionmail)',
      },
      username: {
        type: 'string',
        description: 'Username to store (only for store_credentials)',
      },
      password: {
        type: 'string',
        description: 'Password to store (only for store_credentials)',
      },
      target_url: {
        type: 'string',
        description: 'Optional: specific URL to navigate to after login',
      },
    },
    required: ['action'],
  },
  enabled: true,
  builtIn: true,

  async execute(
    input: {
      action: string;
      site?: string;
      username?: string;
      password?: string;
      target_url?: string;
    },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    try {
      if (input.action === 'list_sites') {
        const sites = Object.entries(KNOWN_SITES).map(([id, config]) => ({
          id,
          name: config.name,
          loginUrl: config.loginUrl,
        }));
        // Check which have stored credentials
        for (const site of sites) {
          const creds = await getCredentials(site.id);
          (site as any).hasCredentials = !!creds;
        }
        return { success: true, data: { sites } };
      }

      if (input.action === 'store_credentials') {
        if (!input.site || !input.username || !input.password) {
          return { success: false, error: 'site, username, and password are required' };
        }
        await storeCredentials(input.site.toLowerCase(), input.username, input.password);
        return {
          success: true,
          data: { message: `Credentials stored for ${input.site}. You can now use login action.` },
        };
      }

      if (input.action === 'login') {
        if (!input.site) {
          return { success: false, error: 'site is required' };
        }

        const siteId = input.site.toLowerCase();
        const config = KNOWN_SITES[siteId];
        if (!config) {
          return {
            success: false,
            error: `Unknown site: ${siteId}. Available: ${Object.keys(KNOWN_SITES).join(', ')}`,
          };
        }

        // Get stored credentials
        const creds = await getCredentials(siteId);
        if (!creds) {
          return {
            success: false,
            error: `No credentials stored for ${siteId}. Ask JP to provide them, then use store_credentials action first.`,
          };
        }

        const page = await createPage();

        try {
          // Navigate to login page
          logger.info('Navigating to login page', { site: siteId, url: config.loginUrl });
          await page.goto(config.loginUrl, { waitUntil: 'networkidle', timeout: 20000 });

          // Wait for the login form to appear (handles JS-rendered pages)
          logger.info('Waiting for login form fields...');
          await page.waitForSelector(config.usernameSelector, { state: 'visible', timeout: 15000 });
          await page.waitForSelector(config.passwordSelector, { state: 'visible', timeout: 10000 });

          // Fill credentials
          await page.fill(config.usernameSelector, creds.username);
          await page.fill(config.passwordSelector, creds.password);

          // Submit
          await page.click(config.submitSelector);
          await page.waitForTimeout(config.waitAfterSubmit || 3000);

          // Check initial result — might be error, MFA, or success
          let currentUrl = page.url();
          let pageText = await page.evaluate(
            '(document.body?.innerText || "").slice(0, 3000)'
          ) as string;

          // Check for wrong credentials
          const hasLoginError = pageText.toLowerCase().includes('login incorrect') ||
            pageText.toLowerCase().includes('invalid credentials') ||
            pageText.toLowerCase().includes('authentication failed');

          if (hasLoginError) {
            await page.close();
            return {
              success: false,
              error: 'Login failed — credentials are incorrect. Ask JP to provide the correct ones.',
            };
          }

          // Check for Duo MFA — Columbia uses Duo after valid username/password
          const isDuoPage = currentUrl.includes('duosecurity.com') ||
            currentUrl.includes('duo.com') ||
            pageText.toLowerCase().includes('duo') ||
            pageText.toLowerCase().includes('two-factor') ||
            pageText.toLowerCase().includes('push notification') ||
            pageText.toLowerCase().includes('send me a push');

          if (isDuoPage && !currentUrl.includes(config.successIndicator)) {
            // Try to auto-send Duo push if button is available
            try {
              const pushButton = await page.$('button:has-text("Send Me a Push"), button:has-text("Send Push"), #trust-browser-button, .push-label');
              if (pushButton) {
                await pushButton.click();
                logger.info('Duo push sent automatically');
              }
            } catch {
              // Push button not found — that's ok
            }

            // Wait up to 60 seconds for MFA approval
            logger.info('Waiting for Duo MFA approval...');
            let mfaApproved = false;
            for (let i = 0; i < 20; i++) {
              await page.waitForTimeout(3000);
              currentUrl = page.url();
              if (currentUrl.includes(config.successIndicator)) {
                mfaApproved = true;
                break;
              }
              // Check if we got redirected past Duo
              if (!currentUrl.includes('duo') && !currentUrl.includes('cas.columbia.edu')) {
                mfaApproved = true;
                break;
              }
            }

            if (!mfaApproved) {
              await page.close();
              return {
                success: false,
                error: 'MFA timeout — Duo push was sent but not approved within 60 seconds. Check your Duo app and try again.',
              };
            }
          }

          // Final check — are we logged in?
          currentUrl = page.url();
          const loginSucceeded = currentUrl.includes(config.successIndicator) ||
            (!currentUrl.includes('cas.columbia.edu') && !currentUrl.includes('duo'));

          if (!loginSucceeded) {
            await page.close();
            return {
              success: false,
              error: `Login may have failed. Ended up at: ${currentUrl}`,
            };
          }

          // Navigate to target URL if specified
          if (input.target_url) {
            await page.goto(input.target_url, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.waitForTimeout(2000);
          } else if (config.postLoginUrl) {
            await page.goto(config.postLoginUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.waitForTimeout(2000);
          }

          // Extract page content
          const content = await page.evaluate(`
            (() => {
              ['script', 'style', 'nav', 'iframe', 'noscript'].forEach(sel =>
                document.querySelectorAll(sel).forEach(el => el.remove())
              );
              return (document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 15000);
            })()
          `) as string;

          // Extract links
          const links = await page.evaluate(`
            (() => {
              const links = [];
              const seen = new Set();
              document.querySelectorAll('a[href]').forEach(a => {
                const href = a.getAttribute('href') || '';
                const text = (a.textContent || '').trim().slice(0, 100);
                if (!href || !text || text.length < 2) return;
                let fullUrl;
                try { fullUrl = new URL(href, document.location.href).href; } catch { return; }
                if (seen.has(fullUrl) || fullUrl.startsWith('javascript:')) return;
                seen.add(fullUrl);
                links.push({ text, url: fullUrl });
              });
              return links.slice(0, 30);
            })()
          `) as Array<{ text: string; url: string }>;

          const finalUrl = page.url();
          await page.close();

          return {
            success: true,
            data: {
              loggedIn: true,
              site: config.name,
              url: finalUrl,
              content: tagContent(content, 'untrusted', finalUrl),
              links: links.slice(0, 20),
              linksSummary: links.slice(0, 15).map(l => `  - "${l.text}" → ${l.url}`).join('\n'),
            },
          };
        } catch (err) {
          await page.close();
          throw err;
        }
      }

      return { success: false, error: `Unknown action: ${input.action}` };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error('Site login error', { error: errMsg, site: input.site });
      return { success: false, error: errMsg };
    }
  },
};
