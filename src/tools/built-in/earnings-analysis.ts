import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import {
  getQuote,
  getCompanyProfile,
  getCompanyFinancials,
  getEarningsCalendar,
  lookupCIK,
  getCompanyFilings,
  getFilingDocument,
} from '../../services/finance-apis.js';
import logger from '../../utils/logger.js';

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return 'N/A';
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

function metric(report: any[], label: string): number | null {
  if (!report) return null;
  const entry = report.find((r: any) => r.concept?.toLowerCase().includes(label.toLowerCase()));
  return entry?.value ?? null;
}

export const earningsAnalysisTool: ToolDefinition = {
  name: 'earnings_analysis',
  description: 'Comprehensive earnings and financial analysis for a company. Fetches profile, income statement, balance sheet, cash flow, earnings surprises, and the latest 10-Q filing — all in one call. The ReAct loop synthesizes the analysis.',
  category: 'informational',
  requiresApproval: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      ticker: { type: 'string', description: 'Stock ticker symbol to analyze' },
    },
    required: ['ticker'],
  },
  enabled: true,
  builtIn: true,

  async execute(input: { ticker: string }, ctx: ToolContext): Promise<ToolResult> {
    const ticker = input.ticker.toUpperCase();

    try {
      // Fire all API calls in parallel for speed
      const [
        quoteData,
        profile,
        incomeData,
        balanceData,
        cashFlowData,
        cik,
      ] = await Promise.all([
        getQuote(ticker).catch(() => null),
        getCompanyProfile(ticker).catch(() => null),
        getCompanyFinancials(ticker, 'ic', 'quarterly').catch(() => ({ data: [] })),
        getCompanyFinancials(ticker, 'bs', 'quarterly').catch(() => ({ data: [] })),
        getCompanyFinancials(ticker, 'cf', 'quarterly').catch(() => ({ data: [] })),
        lookupCIK(ticker).catch(() => null),
      ]);

      // Earnings calendar — look back 1 year and forward 3 months
      const now = new Date();
      const oneYearAgo = new Date(now.getTime() - 365 * 86400000).toISOString().split('T')[0];
      const threeMonthsOut = new Date(now.getTime() + 90 * 86400000).toISOString().split('T')[0];
      const earningsData = await getEarningsCalendar(oneYearAgo, threeMonthsOut).catch(() => ({ earningsCalendar: [] }));
      const companyEarnings = earningsData.earningsCalendar.filter((e) => e.symbol === ticker).slice(0, 6);

      // Latest 10-Q from EDGAR
      let latestFilingText = '';
      let latestFilingUrl = '';
      if (cik) {
        try {
          const filings = await getCompanyFilings(cik);
          const tenQ = filings.find((f) => f.form === '10-Q');
          if (tenQ) {
            latestFilingUrl = tenQ.filingUrl;
            latestFilingText = await getFilingDocument(tenQ.filingUrl).catch(() => '');
            latestFilingText = latestFilingText.slice(0, 3000);
          }
        } catch {
          // Non-critical — continue without filing text
        }
      }

      // Build structured summary
      const sections: string[] = [];

      // 1. Profile + Quote
      if (profile?.name) {
        const mcap = profile.marketCapitalization;
        const mcapStr = mcap >= 1000 ? `$${(mcap / 1000).toFixed(1)}T` : `$${mcap.toFixed(1)}B`;
        sections.push(`## Company Profile\n*${profile.name}* (${ticker}) — ${profile.finnhubIndustry}\nMarket Cap: ${mcapStr} | Exchange: ${profile.exchange}`);
      }

      if (quoteData?.c) {
        const changeEmoji = quoteData.d >= 0 ? '📈' : '📉';
        sections.push(`## Current Price\n${changeEmoji} $${quoteData.c.toFixed(2)} (${quoteData.d >= 0 ? '+' : ''}${quoteData.dp.toFixed(2)}%)`);
      }

      // 2. Income Statement (latest 2 quarters)
      const incomeReports = incomeData.data?.slice(0, 2) || [];
      if (incomeReports.length > 0) {
        const lines = incomeReports.map((r) => {
          const ic = r.report?.ic || [];
          return `*Q${r.quarter} ${r.year}*: Revenue ${fmt(metric(ic, 'revenue') ?? metric(ic, 'sales'))} | Net Income ${fmt(metric(ic, 'netincome'))} | EPS ${metric(ic, 'earningspershare') !== null ? `$${metric(ic, 'earningspershare')!.toFixed(2)}` : 'N/A'}`;
        });
        sections.push(`## Income Statement (Quarterly)\n${lines.join('\n')}`);
      }

      // 3. Balance Sheet (latest)
      const bsReport = balanceData.data?.[0];
      if (bsReport) {
        const bs = bsReport.report?.bs || [];
        sections.push(`## Balance Sheet (Q${bsReport.quarter} ${bsReport.year})\nAssets: ${fmt(metric(bs, 'totalassets'))} | Liabilities: ${fmt(metric(bs, 'totalliabilities'))} | Equity: ${fmt(metric(bs, 'stockholdersequity') ?? metric(bs, 'equity'))} | Cash: ${fmt(metric(bs, 'cashandcashequivalents') ?? metric(bs, 'cash'))}`);
      }

      // 4. Cash Flow (latest)
      const cfReport = cashFlowData.data?.[0];
      if (cfReport) {
        const cf = cfReport.report?.cf || [];
        const opCash = metric(cf, 'operatingcashflow') ?? metric(cf, 'netcashfromoperating');
        const capex = metric(cf, 'capitalexpenditure') ?? metric(cf, 'purchaseofproperty');
        const fcf = opCash !== null && capex !== null ? opCash + capex : null;
        sections.push(`## Cash Flow (Q${cfReport.quarter} ${cfReport.year})\nOperating: ${fmt(opCash)} | CapEx: ${fmt(capex)} | *FCF: ${fmt(fcf)}*`);
      }

      // 5. Earnings Surprises
      if (companyEarnings.length > 0) {
        const lines = companyEarnings.map((e) => {
          if (e.actual !== null && e.estimate !== null) {
            const emoji = e.surprise !== null && e.surprise >= 0 ? '✅' : '❌';
            return `${emoji} Q${e.quarter} ${e.year}: Actual $${e.actual.toFixed(2)} vs Est $${e.estimate.toFixed(2)} (${e.surprisePercent !== null ? `${e.surprisePercent >= 0 ? '+' : ''}${e.surprisePercent.toFixed(1)}%` : 'N/A'})`;
          }
          return `⏳ Q${e.quarter} ${e.year}: Est $${e.estimate?.toFixed(2) || 'N/A'} (upcoming)`;
        });
        sections.push(`## Earnings History\n${lines.join('\n')}`);
      }

      // 6. Latest 10-Q snippet
      if (latestFilingText) {
        sections.push(`## Latest 10-Q Filing\n${latestFilingUrl}\n\n${latestFilingText.slice(0, 1500)}...`);
      }

      const formatted = sections.join('\n\n');

      return {
        success: true,
        data: {
          ticker,
          profile,
          quote: quoteData,
          incomeReports,
          balanceSheet: bsReport,
          cashFlow: cfReport,
          earnings: companyEarnings,
          latestFilingUrl,
          formatted,
        },
      };
    } catch (err) {
      logger.error('Earnings analysis error', { error: err, ticker });
      return { success: false, error: err instanceof Error ? err.message : 'Earnings analysis failed' };
    }
  },
};
