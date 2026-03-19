import { getEnv } from '../config/env.js';
import logger from '../utils/logger.js';

// ===== Types =====

export interface FinnhubQuote {
  c: number;  // current price
  d: number;  // change
  dp: number; // percent change
  h: number;  // high
  l: number;  // low
  o: number;  // open
  pc: number; // previous close
  t: number;  // timestamp
}

export interface FinnhubProfile {
  ticker: string;
  name: string;
  country: string;
  currency: string;
  exchange: string;
  ipo: string;
  marketCapitalization: number;
  finnhubIndustry: string;
  logo: string;
  weburl: string;
}

export interface FinnhubCandle {
  c: number[]; // close
  h: number[]; // high
  l: number[]; // low
  o: number[]; // open
  v: number[]; // volume
  t: number[]; // timestamps
  s: string;   // status
}

export interface FinnhubEarning {
  actual: number | null;
  estimate: number | null;
  period: string;
  quarter: number;
  surprise: number | null;
  surprisePercent: number | null;
  symbol: string;
  year: number;
}

export interface FinnhubNewsItem {
  category: string;
  datetime: number;
  headline: string;
  id: number;
  image: string;
  related: string;
  source: string;
  summary: string;
  url: string;
}

export interface FinnhubFinancialReport {
  accessNumber: string;
  symbol: string;
  cik: string;
  year: number;
  quarter: number;
  form: string;
  startDate: string;
  endDate: string;
  filedDate: string;
  report: {
    bs?: any[];  // balance sheet
    ic?: any[];  // income statement
    cf?: any[];  // cash flow
  };
}

export interface SECFiling {
  accessionNumber: string;
  filingDate: string;
  reportDate: string;
  form: string;
  primaryDocument: string;
  primaryDocDescription: string;
  filingUrl: string;
}

export interface SECSearchResult {
  accessionNumber: string;
  filedAt: string;
  formType: string;
  entityName: string;
  ticker: string;
  url: string;
}

// ===== Rate Limiter =====

class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per ms

  constructor(maxPerMinute: number) {
    this.maxTokens = maxPerMinute;
    this.tokens = maxPerMinute;
    this.lastRefill = Date.now();
    this.refillRate = maxPerMinute / 60000;
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens < 1) {
      const waitMs = Math.ceil((1 - this.tokens) / this.refillRate);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.refill();
    }
    this.tokens -= 1;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

// 55 calls/min to stay under Finnhub's 60/min limit
const finnhubLimiter = new TokenBucketRateLimiter(55);

// ===== Finnhub API =====

async function finnhubFetch<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
  await finnhubLimiter.acquire();

  const apiKey = getEnv().FINNHUB_API_KEY;
  if (!apiKey) throw new Error('FINNHUB_API_KEY not configured');

  const url = new URL(`https://finnhub.io/api/v1${endpoint}`);
  url.searchParams.set('token', apiKey);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Finnhub API error ${response.status}: ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export async function getQuote(ticker: string): Promise<FinnhubQuote> {
  return finnhubFetch<FinnhubQuote>('/quote', { symbol: ticker.toUpperCase() });
}

export async function getCompanyProfile(ticker: string): Promise<FinnhubProfile> {
  return finnhubFetch<FinnhubProfile>('/stock/profile2', { symbol: ticker.toUpperCase() });
}

export async function getCompanyFinancials(
  ticker: string,
  statement: 'ic' | 'bs' | 'cf' = 'ic',
  freq: 'annual' | 'quarterly' = 'quarterly'
): Promise<{ data: FinnhubFinancialReport[] }> {
  return finnhubFetch('/stock/financials-reported', {
    symbol: ticker.toUpperCase(),
    statement,
    freq,
  });
}

export async function getEarningsCalendar(
  from: string,
  to: string
): Promise<{ earningsCalendar: FinnhubEarning[] }> {
  return finnhubFetch('/calendar/earnings', { from, to });
}

export async function getCompanyNews(
  ticker: string,
  from: string,
  to: string
): Promise<FinnhubNewsItem[]> {
  return finnhubFetch<FinnhubNewsItem[]>('/company-news', {
    symbol: ticker.toUpperCase(),
    from,
    to,
  });
}

export async function getStockCandles(
  ticker: string,
  resolution: string,
  from: number,
  to: number
): Promise<FinnhubCandle> {
  return finnhubFetch<FinnhubCandle>('/stock/candle', {
    symbol: ticker.toUpperCase(),
    resolution,
    from: from.toString(),
    to: to.toString(),
  });
}

// ===== SEC EDGAR API =====

const SEC_USER_AGENT = 'Atlas/1.0 (jpperalta@columbia.edu)';

async function secFetch(url: string): Promise<any> {
  const response = await fetch(url, {
    headers: { 'User-Agent': SEC_USER_AGENT, 'Accept': 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`SEC EDGAR error ${response.status}: ${response.statusText}`);
  }
  return response.json();
}

// Cache for the ticker → CIK mapping (loaded once)
let cikMap: Record<string, string> | null = null;

export async function lookupCIK(ticker: string): Promise<string | null> {
  if (!cikMap) {
    try {
      const data = await secFetch('https://www.sec.gov/files/company_tickers.json');
      cikMap = {};
      for (const entry of Object.values(data) as any[]) {
        cikMap[entry.ticker.toUpperCase()] = String(entry.cik_str).padStart(10, '0');
      }
    } catch (err) {
      logger.error('Failed to load SEC CIK mapping', { error: err });
      return null;
    }
  }
  return cikMap[ticker.toUpperCase()] || null;
}

export async function getCompanyFilings(cik: string): Promise<SECFiling[]> {
  const paddedCik = cik.padStart(10, '0');
  const data = await secFetch(`https://data.sec.gov/submissions/CIK${paddedCik}.json`);

  const recent = data.filings?.recent;
  if (!recent) return [];

  const filings: SECFiling[] = [];
  const count = Math.min(recent.accessionNumber?.length || 0, 25);

  for (let i = 0; i < count; i++) {
    const accession = recent.accessionNumber[i];
    const accessionDashed = accession.replace(/-/g, '');
    filings.push({
      accessionNumber: accession,
      filingDate: recent.filingDate[i],
      reportDate: recent.reportDate?.[i] || '',
      form: recent.form[i],
      primaryDocument: recent.primaryDocument?.[i] || '',
      primaryDocDescription: recent.primaryDocDescription?.[i] || '',
      filingUrl: `https://www.sec.gov/Archives/edgar/data/${cik.replace(/^0+/, '')}/${accessionDashed}/${recent.primaryDocument?.[i] || ''}`,
    });
  }

  return filings;
}

export async function searchEdgarFilings(
  query: string,
  dateRange?: string,
  forms?: string[]
): Promise<SECSearchResult[]> {
  const params = new URLSearchParams({ q: query, dateRange: dateRange || '', forms: forms?.join(',') || '' });
  const data = await secFetch(`https://efts.sec.gov/LATEST/search-index?${params.toString()}`);

  if (!data.hits?.hits) return [];

  return data.hits.hits.map((hit: any) => ({
    accessionNumber: hit._source?.file_num || hit._id,
    filedAt: hit._source?.file_date || '',
    formType: hit._source?.form_type || '',
    entityName: hit._source?.entity_name || '',
    ticker: hit._source?.tickers?.[0] || '',
    url: `https://www.sec.gov/Archives/edgar/data/${hit._source?.entity_id || ''}/${hit._id?.replace(/-/g, '')}/`,
  }));
}

export async function getFilingDocument(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { 'User-Agent': SEC_USER_AGENT },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch filing: ${response.status}`);
  }

  let text = await response.text();

  // Strip HTML tags if present
  text = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

  // Truncate to 10K chars
  if (text.length > 10000) {
    text = text.slice(0, 10000) + '\n\n[... truncated at 10,000 characters]';
  }

  return text;
}
