import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { query } from '../../config/database.js';
import { getQuote, getStockCandles, getCompanyProfile } from '../../services/finance-apis.js';
import logger from '../../utils/logger.js';

export const stockPriceTool: ToolDefinition = {
  name: 'stock_price',
  description: 'Get real-time stock quotes, historical price data, and manage price alerts. Actions: quote, history, set_alert, remove_alert, list_alerts.',
  category: 'action',
  requiresApproval: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['quote', 'history', 'set_alert', 'remove_alert', 'list_alerts'],
        description: 'Action to perform',
      },
      ticker: { type: 'string', description: 'Stock ticker symbol (e.g., AAPL, TSLA)' },
      period: {
        type: 'string',
        enum: ['1d', '1w', '1m', '3m', '6m', '1y'],
        description: 'History period (default: 1m)',
      },
      alert_type: {
        type: 'string',
        enum: ['drop_pct', 'rise_pct', 'below_price', 'above_price'],
        description: 'Type of price alert',
      },
      threshold: { type: 'number', description: 'Alert threshold (percentage or absolute price)' },
      rearm: { type: 'boolean', description: 'Whether to rearm alert after triggering (default: false)' },
    },
    required: ['action'],
  },
  enabled: true,
  builtIn: true,

  async execute(input: {
    action: string;
    ticker?: string;
    period?: string;
    alert_type?: string;
    threshold?: number;
    rearm?: boolean;
  }, ctx: ToolContext): Promise<ToolResult> {
    try {
      switch (input.action) {
        case 'quote': {
          if (!input.ticker) return { success: false, error: 'Ticker required for quote' };
          const ticker = input.ticker.toUpperCase();
          const [quoteData, profile] = await Promise.all([
            getQuote(ticker),
            getCompanyProfile(ticker).catch(() => null),
          ]);

          if (!quoteData.c || quoteData.c === 0) {
            return { success: false, error: `No quote data found for ${ticker}. Verify the ticker symbol.` };
          }

          const changeEmoji = quoteData.d >= 0 ? '📈' : '📉';
          const formatted = [
            `${changeEmoji} *${profile?.name || ticker}* (${ticker})`,
            `*Price:* $${quoteData.c.toFixed(2)}`,
            `*Change:* ${quoteData.d >= 0 ? '+' : ''}${quoteData.d.toFixed(2)} (${quoteData.dp >= 0 ? '+' : ''}${quoteData.dp.toFixed(2)}%)`,
            `*Day Range:* $${quoteData.l.toFixed(2)} — $${quoteData.h.toFixed(2)}`,
            `*Open:* $${quoteData.o.toFixed(2)} | *Prev Close:* $${quoteData.pc.toFixed(2)}`,
          ];

          if (profile?.marketCapitalization) {
            const mcap = profile.marketCapitalization;
            const mcapStr = mcap >= 1000 ? `$${(mcap / 1000).toFixed(1)}T` : `$${mcap.toFixed(1)}B`;
            formatted.push(`*Market Cap:* ${mcapStr} | *Industry:* ${profile.finnhubIndustry || 'N/A'}`);
          }

          return { success: true, data: { quote: quoteData, profile, formatted: formatted.join('\n') } };
        }

        case 'history': {
          if (!input.ticker) return { success: false, error: 'Ticker required for history' };
          const ticker = input.ticker.toUpperCase();
          const period = input.period || '1m';
          const now = Math.floor(Date.now() / 1000);
          const periodMap: Record<string, { seconds: number; resolution: string }> = {
            '1d': { seconds: 86400, resolution: '5' },
            '1w': { seconds: 604800, resolution: '60' },
            '1m': { seconds: 2592000, resolution: 'D' },
            '3m': { seconds: 7776000, resolution: 'D' },
            '6m': { seconds: 15552000, resolution: 'W' },
            '1y': { seconds: 31536000, resolution: 'W' },
          };
          const config = periodMap[period] || periodMap['1m'];
          const from = now - config.seconds;

          const candles = await getStockCandles(ticker, config.resolution, from, now);

          if (candles.s !== 'ok' || !candles.c?.length) {
            return { success: false, error: `No historical data for ${ticker} over ${period}` };
          }

          const startPrice = candles.o[0];
          const endPrice = candles.c[candles.c.length - 1];
          const high = Math.max(...candles.h);
          const low = Math.min(...candles.l);
          const totalVol = candles.v.reduce((a, b) => a + b, 0);
          const changePct = ((endPrice - startPrice) / startPrice * 100);

          const formatted = [
            `*${ticker}* — ${period} History`,
            `*Start:* $${startPrice.toFixed(2)} → *End:* $${endPrice.toFixed(2)} (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%)`,
            `*High:* $${high.toFixed(2)} | *Low:* $${low.toFixed(2)}`,
            `*Total Volume:* ${(totalVol / 1e6).toFixed(1)}M`,
            `*Data Points:* ${candles.c.length}`,
          ];

          return { success: true, data: { candles, summary: { startPrice, endPrice, high, low, changePct }, formatted: formatted.join('\n') } };
        }

        case 'set_alert': {
          if (!input.ticker) return { success: false, error: 'Ticker required' };
          if (!input.alert_type) return { success: false, error: 'alert_type required (drop_pct, rise_pct, below_price, above_price)' };
          if (input.threshold === undefined) return { success: false, error: 'threshold required' };

          const ticker = input.ticker.toUpperCase();
          const quoteData = await getQuote(ticker);
          if (!quoteData.c || quoteData.c === 0) {
            return { success: false, error: `Cannot get current price for ${ticker}` };
          }

          const profile = await getCompanyProfile(ticker).catch(() => null);
          const result = await query(
            `INSERT INTO stock_watchlist (ticker, company_name, alert_type, threshold, reference_price, current_price, rearm)
             VALUES ($1, $2, $3, $4, $5, $5, $6)
             RETURNING id`,
            [ticker, profile?.name || ticker, input.alert_type, input.threshold, quoteData.c, input.rearm || false]
          );

          const typeLabels: Record<string, string> = {
            drop_pct: `drops ${input.threshold}%`,
            rise_pct: `rises ${input.threshold}%`,
            below_price: `goes below $${input.threshold}`,
            above_price: `goes above $${input.threshold}`,
          };

          return {
            success: true,
            data: {
              id: result.rows[0].id,
              formatted: `🔔 Alert set: *${profile?.name || ticker}* (${ticker})\nTrigger: when price ${typeLabels[input.alert_type]}\nReference price: $${quoteData.c.toFixed(2)}\nRearm: ${input.rearm ? 'Yes' : 'No'}`,
            },
          };
        }

        case 'remove_alert': {
          if (!input.ticker) return { success: false, error: 'Ticker required' };
          const ticker = input.ticker.toUpperCase();

          const result = await query(
            `UPDATE stock_watchlist SET status = 'cancelled', updated_at = NOW()
             WHERE ticker = $1 AND status = 'active'
             RETURNING id`,
            [ticker]
          );

          return {
            success: true,
            data: {
              cancelled: result.rowCount || 0,
              formatted: result.rowCount
                ? `Cancelled ${result.rowCount} alert(s) for ${ticker}.`
                : `No active alerts found for ${ticker}.`,
            },
          };
        }

        case 'list_alerts': {
          const result = await query(
            `SELECT ticker, company_name, alert_type, threshold, reference_price, current_price, rearm, status, created_at
             FROM stock_watchlist
             WHERE status IN ('active', 'triggered')
             ORDER BY created_at DESC`
          );

          if (result.rows.length === 0) {
            return { success: true, data: { alerts: [], formatted: 'No active price alerts.' } };
          }

          const lines = result.rows.map((r: any) => {
            const typeLabels: Record<string, string> = {
              drop_pct: `drop ${r.threshold}%`,
              rise_pct: `rise ${r.threshold}%`,
              below_price: `< $${r.threshold}`,
              above_price: `> $${r.threshold}`,
            };
            const statusEmoji = r.status === 'active' ? '🟢' : '🔴';
            return `${statusEmoji} *${r.ticker}* — ${typeLabels[r.alert_type] || r.alert_type} (ref: $${Number(r.reference_price).toFixed(2)}, now: $${Number(r.current_price).toFixed(2)})`;
          });

          return { success: true, data: { alerts: result.rows, formatted: `*Price Alerts:*\n${lines.join('\n')}` } };
        }

        default:
          return { success: false, error: `Unknown action: ${input.action}. Use: quote, history, set_alert, remove_alert, list_alerts` };
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Stock price operation failed';
      logger.error('Stock price tool error', { error: errMsg, action: input.action, ticker: input.ticker });

      // If API key is missing, give clear instructions
      if (errMsg.includes('not configured') || errMsg.includes('API key')) {
        return { success: false, error: `FINNHUB_API_KEY is not configured on the server. Cannot fetch real stock data. DO NOT guess prices from memory — tell JP that the finance API key needs to be added to Railway.` };
      }

      return { success: false, error: `Stock price tool failed: ${errMsg}. Try again or use web_search as fallback to find current prices.` };
    }
  },
};
