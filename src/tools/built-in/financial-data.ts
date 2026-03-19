import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { tagContent } from '../../security/content-trust.js';
import {
  getCompanyFinancials,
  getEarningsCalendar,
  getCompanyNews,
  getCompanyProfile,
} from '../../services/finance-apis.js';
import logger from '../../utils/logger.js';

function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return 'N/A';
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

function findMetric(report: any[], label: string): number | null {
  if (!report) return null;
  const entry = report.find((r: any) => r.concept?.toLowerCase().includes(label.toLowerCase()));
  return entry?.value ?? null;
}

export const financialDataTool: ToolDefinition = {
  name: 'financial_data',
  description: 'Retrieve detailed financial data: income statements, balance sheets, cash flows, earnings calendar, company news, and profile. Actions: income_statement, balance_sheet, cash_flow, earnings_calendar, company_news, company_profile.',
  category: 'informational',
  requiresApproval: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['income_statement', 'balance_sheet', 'cash_flow', 'earnings_calendar', 'company_news', 'company_profile'],
        description: 'Action to perform',
      },
      ticker: { type: 'string', description: 'Stock ticker symbol' },
      period: {
        type: 'string',
        enum: ['quarterly', 'annual'],
        description: 'Reporting period (default: quarterly)',
      },
      from: { type: 'string', description: 'Start date (YYYY-MM-DD) for calendar/news' },
      to: { type: 'string', description: 'End date (YYYY-MM-DD) for calendar/news' },
    },
    required: ['action'],
  },
  enabled: true,
  builtIn: true,

  async execute(input: {
    action: string;
    ticker?: string;
    period?: string;
    from?: string;
    to?: string;
  }, ctx: ToolContext): Promise<ToolResult> {
    try {
      switch (input.action) {
        case 'income_statement': {
          if (!input.ticker) return { success: false, error: 'Ticker required' };
          const ticker = input.ticker.toUpperCase();
          const freq = (input.period as 'annual' | 'quarterly') || 'quarterly';

          const data = await getCompanyFinancials(ticker, 'ic', freq);
          const reports = data.data?.slice(0, 4) || [];

          if (reports.length === 0) return { success: true, data: { formatted: `No income statement data for ${ticker}.` } };

          const lines = reports.map((r) => {
            const ic = r.report?.ic || [];
            const revenue = findMetric(ic, 'revenue') ?? findMetric(ic, 'sales');
            const cogs = findMetric(ic, 'costofgoodssold') ?? findMetric(ic, 'costofrevenue');
            const grossProfit = findMetric(ic, 'grossprofit');
            const opIncome = findMetric(ic, 'operatingincome');
            const netIncome = findMetric(ic, 'netincome');
            const eps = findMetric(ic, 'earningspershare') ?? findMetric(ic, 'eps');

            return [
              `*${r.form} — ${r.endDate}* (Q${r.quarter} ${r.year})`,
              `  Revenue: ${formatNumber(revenue)}`,
              `  COGS: ${formatNumber(cogs)}`,
              `  Gross Profit: ${formatNumber(grossProfit)}`,
              `  Operating Income: ${formatNumber(opIncome)}`,
              `  Net Income: ${formatNumber(netIncome)}`,
              eps !== null ? `  EPS: $${eps.toFixed(2)}` : '',
            ].filter(Boolean).join('\n');
          });

          return {
            success: true,
            data: {
              reports,
              formatted: `*${ticker} Income Statement* (${freq})\n\n${lines.join('\n\n')}`,
            },
          };
        }

        case 'balance_sheet': {
          if (!input.ticker) return { success: false, error: 'Ticker required' };
          const ticker = input.ticker.toUpperCase();
          const freq = (input.period as 'annual' | 'quarterly') || 'quarterly';

          const data = await getCompanyFinancials(ticker, 'bs', freq);
          const reports = data.data?.slice(0, 4) || [];

          if (reports.length === 0) return { success: true, data: { formatted: `No balance sheet data for ${ticker}.` } };

          const lines = reports.map((r) => {
            const bs = r.report?.bs || [];
            const totalAssets = findMetric(bs, 'totalassets') ?? findMetric(bs, 'assets');
            const totalLiabilities = findMetric(bs, 'totalliabilities') ?? findMetric(bs, 'liabilities');
            const equity = findMetric(bs, 'stockholdersequity') ?? findMetric(bs, 'equity');
            const cash = findMetric(bs, 'cashandcashequivalents') ?? findMetric(bs, 'cash');
            const currentAssets = findMetric(bs, 'currentassets');
            const currentLiabilities = findMetric(bs, 'currentliabilities');

            return [
              `*${r.form} — ${r.endDate}* (Q${r.quarter} ${r.year})`,
              `  Total Assets: ${formatNumber(totalAssets)}`,
              currentAssets !== null ? `  Current Assets: ${formatNumber(currentAssets)}` : '',
              `  Cash: ${formatNumber(cash)}`,
              `  Total Liabilities: ${formatNumber(totalLiabilities)}`,
              currentLiabilities !== null ? `  Current Liabilities: ${formatNumber(currentLiabilities)}` : '',
              `  Equity: ${formatNumber(equity)}`,
            ].filter(Boolean).join('\n');
          });

          return {
            success: true,
            data: {
              reports,
              formatted: `*${ticker} Balance Sheet* (${freq})\n\n${lines.join('\n\n')}`,
            },
          };
        }

        case 'cash_flow': {
          if (!input.ticker) return { success: false, error: 'Ticker required' };
          const ticker = input.ticker.toUpperCase();
          const freq = (input.period as 'annual' | 'quarterly') || 'quarterly';

          const data = await getCompanyFinancials(ticker, 'cf', freq);
          const reports = data.data?.slice(0, 4) || [];

          if (reports.length === 0) return { success: true, data: { formatted: `No cash flow data for ${ticker}.` } };

          const lines = reports.map((r) => {
            const cf = r.report?.cf || [];
            const opCash = findMetric(cf, 'operatingcashflow') ?? findMetric(cf, 'netcashfromoperating');
            const investCash = findMetric(cf, 'investingcashflow') ?? findMetric(cf, 'netcashfrominvesting');
            const finCash = findMetric(cf, 'financingcashflow') ?? findMetric(cf, 'netcashfromfinancing');
            const capex = findMetric(cf, 'capitalexpenditure') ?? findMetric(cf, 'purchaseofproperty');
            const fcf = opCash !== null && capex !== null ? opCash + capex : null; // capex is typically negative

            return [
              `*${r.form} — ${r.endDate}* (Q${r.quarter} ${r.year})`,
              `  Operating Cash Flow: ${formatNumber(opCash)}`,
              `  Investing Cash Flow: ${formatNumber(investCash)}`,
              `  Financing Cash Flow: ${formatNumber(finCash)}`,
              capex !== null ? `  CapEx: ${formatNumber(capex)}` : '',
              fcf !== null ? `  *Free Cash Flow: ${formatNumber(fcf)}*` : '',
            ].filter(Boolean).join('\n');
          });

          return {
            success: true,
            data: {
              reports,
              formatted: `*${ticker} Cash Flow* (${freq})\n\n${lines.join('\n\n')}`,
            },
          };
        }

        case 'earnings_calendar': {
          const now = new Date();
          const from = input.from || now.toISOString().split('T')[0];
          const toDate = input.to || new Date(now.getTime() + 30 * 86400000).toISOString().split('T')[0];

          const data = await getEarningsCalendar(from, toDate);
          let earnings = data.earningsCalendar || [];

          // If ticker specified, filter to just that company
          if (input.ticker) {
            const ticker = input.ticker.toUpperCase();
            earnings = earnings.filter((e) => e.symbol === ticker);
          }

          if (earnings.length === 0) {
            return { success: true, data: { earnings: [], formatted: 'No earnings in this period.' } };
          }

          // Limit to 20 entries for readability
          const limited = earnings.slice(0, 20);
          const lines = limited.map((e) => {
            const surprise = e.surprise !== null
              ? ` | Surprise: ${e.surprise! >= 0 ? '+' : ''}${e.surprise!.toFixed(2)} (${e.surprisePercent?.toFixed(1)}%)`
              : '';
            const est = e.estimate !== null ? `Est: $${e.estimate!.toFixed(2)}` : '';
            const act = e.actual !== null ? `Actual: $${e.actual!.toFixed(2)}` : '';
            return `• *${e.symbol}* — ${e.period} (Q${e.quarter} ${e.year})\n  ${[act, est].filter(Boolean).join(' | ')}${surprise}`;
          });

          return {
            success: true,
            data: {
              earnings: limited,
              formatted: `*Earnings Calendar* (${from} to ${toDate})\n\n${lines.join('\n')}`,
            },
          };
        }

        case 'company_news': {
          if (!input.ticker) return { success: false, error: 'Ticker required' };
          const ticker = input.ticker.toUpperCase();
          const now = new Date();
          const from = input.from || new Date(now.getTime() - 7 * 86400000).toISOString().split('T')[0];
          const to = input.to || now.toISOString().split('T')[0];

          const news = await getCompanyNews(ticker, from, to);

          if (news.length === 0) {
            return { success: true, data: { news: [], formatted: `No recent news for ${ticker}.` } };
          }

          const limited = news.slice(0, 10);
          const lines = limited.map((n) => {
            const date = new Date(n.datetime * 1000).toLocaleDateString('en-US', { timeZone: 'America/New_York' });
            return `• *${n.headline}*\n  ${n.source} — ${date}\n  ${tagContent(n.summary?.slice(0, 150) || '', 'untrusted', 'finnhub_news')}\n  ${n.url}`;
          });

          return {
            success: true,
            data: {
              news: limited,
              formatted: `*${ticker} News* (${from} to ${to})\n\n${lines.join('\n\n')}`,
            },
          };
        }

        case 'company_profile': {
          if (!input.ticker) return { success: false, error: 'Ticker required' };
          const ticker = input.ticker.toUpperCase();

          const profile = await getCompanyProfile(ticker);
          if (!profile?.name) return { success: false, error: `No profile data for ${ticker}` };

          const mcap = profile.marketCapitalization;
          const mcapStr = mcap >= 1000 ? `$${(mcap / 1000).toFixed(1)}T` : `$${mcap.toFixed(1)}B`;

          const formatted = [
            `*${profile.name}* (${profile.ticker})`,
            `*Industry:* ${profile.finnhubIndustry}`,
            `*Market Cap:* ${mcapStr}`,
            `*Exchange:* ${profile.exchange}`,
            `*Country:* ${profile.country}`,
            `*IPO Date:* ${profile.ipo}`,
            `*Website:* ${profile.weburl}`,
          ].join('\n');

          return { success: true, data: { profile, formatted } };
        }

        default:
          return { success: false, error: `Unknown action: ${input.action}` };
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Financial data operation failed';
      logger.error('Financial data tool error', { error: errMsg, action: input.action, ticker: input.ticker });
      if (errMsg.includes('not configured') || errMsg.includes('API key')) {
        return { success: false, error: `FINNHUB_API_KEY is not configured. Cannot fetch financial data. DO NOT guess — tell JP the API key needs to be added.` };
      }
      return { success: false, error: `Financial data failed: ${errMsg}. Try web_search as fallback.` };
    }
  },
};
