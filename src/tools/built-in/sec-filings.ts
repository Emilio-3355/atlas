import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { query } from '../../config/database.js';
import { lookupCIK, getCompanyFilings, getFilingDocument, getCompanyProfile } from '../../services/finance-apis.js';
import logger from '../../utils/logger.js';

export const secFilingsTool: ToolDefinition = {
  name: 'sec_filings',
  description: 'Search SEC EDGAR for company filings (10-K, 10-Q, 8-K, etc.), read filing documents, and manage a watchlist for automatic filing alerts. Actions: search, get_filing, watch, unwatch, list_watched.',
  category: 'action',
  requiresApproval: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['search', 'get_filing', 'watch', 'unwatch', 'list_watched'],
        description: 'Action to perform',
      },
      ticker: { type: 'string', description: 'Stock ticker symbol' },
      filing_url: { type: 'string', description: 'URL of specific filing document to read' },
      filing_types: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filing types to watch (default: 10-K, 10-Q, 8-K)',
      },
    },
    required: ['action'],
  },
  enabled: true,
  builtIn: true,

  async execute(input: {
    action: string;
    ticker?: string;
    filing_url?: string;
    filing_types?: string[];
  }, ctx: ToolContext): Promise<ToolResult> {
    try {
      switch (input.action) {
        case 'search': {
          if (!input.ticker) return { success: false, error: 'Ticker required for search' };
          const ticker = input.ticker.toUpperCase();

          const cik = await lookupCIK(ticker);
          if (!cik) return { success: false, error: `Could not find CIK for ${ticker}. Verify the ticker symbol.` };

          const filings = await getCompanyFilings(cik);
          if (filings.length === 0) return { success: true, data: { filings: [], formatted: `No filings found for ${ticker}.` } };

          const lines = filings.slice(0, 15).map((f) => {
            const formBadge = f.form === '10-K' ? '📊' : f.form === '10-Q' ? '📋' : f.form === '8-K' ? '⚡' : '📄';
            return `${formBadge} *${f.form}* — ${f.filingDate}${f.primaryDocDescription ? ` (${f.primaryDocDescription})` : ''}\n   ${f.filingUrl}`;
          });

          return {
            success: true,
            data: {
              filings: filings.slice(0, 15),
              cik,
              formatted: `*SEC Filings for ${ticker}* (CIK: ${cik})\n\n${lines.join('\n\n')}`,
            },
          };
        }

        case 'get_filing': {
          if (!input.filing_url) return { success: false, error: 'filing_url required to read a filing' };

          const text = await getFilingDocument(input.filing_url);

          return {
            success: true,
            data: {
              text: text.slice(0, 5000),
              url: input.filing_url,
              formatted: `*Filing Document*\n${input.filing_url}\n\n${text.slice(0, 3000)}${text.length > 3000 ? '\n\n[... truncated]' : ''}`,
            },
          };
        }

        case 'watch': {
          if (!input.ticker) return { success: false, error: 'Ticker required for watch' };
          const ticker = input.ticker.toUpperCase();

          const cik = await lookupCIK(ticker);
          if (!cik) return { success: false, error: `Could not find CIK for ${ticker}` };

          const profile = await getCompanyProfile(ticker).catch(() => null);
          const filingTypes = input.filing_types || ['10-K', '10-Q', '8-K'];

          // Get the latest filing date to avoid alerting on old filings
          const filings = await getCompanyFilings(cik);
          const latestDate = filings.length > 0 ? filings[0].filingDate : null;

          const result = await query(
            `INSERT INTO sec_watchlist (ticker, company_name, cik, filing_types, last_filing_date, last_checked_at)
             VALUES ($1, $2, $3, $4, $5, NOW())
             ON CONFLICT (cik) DO UPDATE SET
               status = 'active',
               filing_types = $4,
               updated_at = NOW()
             RETURNING id`,
            [ticker, profile?.name || ticker, cik, filingTypes, latestDate]
          );

          return {
            success: true,
            data: {
              id: result.rows[0].id,
              formatted: `👁️ Now watching *${profile?.name || ticker}* (${ticker}) for SEC filings\nTypes: ${filingTypes.join(', ')}\nCIK: ${cik}`,
            },
          };
        }

        case 'unwatch': {
          if (!input.ticker) return { success: false, error: 'Ticker required for unwatch' };
          const ticker = input.ticker.toUpperCase();

          const result = await query(
            `UPDATE sec_watchlist SET status = 'cancelled', updated_at = NOW()
             WHERE ticker = $1 AND status = 'active'
             RETURNING id`,
            [ticker]
          );

          return {
            success: true,
            data: {
              cancelled: result.rowCount || 0,
              formatted: result.rowCount
                ? `Stopped watching ${ticker} for SEC filings.`
                : `${ticker} is not on the SEC watchlist.`,
            },
          };
        }

        case 'list_watched': {
          const result = await query(
            `SELECT ticker, company_name, cik, filing_types, last_filing_date, last_checked_at, status
             FROM sec_watchlist
             WHERE status = 'active'
             ORDER BY created_at DESC`
          );

          if (result.rows.length === 0) {
            return { success: true, data: { watched: [], formatted: 'No companies on SEC watchlist.' } };
          }

          const lines = result.rows.map((r: any) => {
            const lastChecked = r.last_checked_at
              ? new Date(r.last_checked_at).toLocaleDateString('en-US', { timeZone: 'America/New_York' })
              : 'Never';
            return `• *${r.ticker}* (${r.company_name}) — ${r.filing_types.join(', ')}\n  Last checked: ${lastChecked}`;
          });

          return { success: true, data: { watched: result.rows, formatted: `*SEC Watchlist:*\n${lines.join('\n')}` } };
        }

        default:
          return { success: false, error: `Unknown action: ${input.action}. Use: search, get_filing, watch, unwatch, list_watched` };
      }
    } catch (err) {
      logger.error('SEC filings tool error', { error: err, action: input.action, ticker: input.ticker });
      return { success: false, error: err instanceof Error ? err.message : 'SEC filings operation failed' };
    }
  },
};
