import { query } from '../config/database.js';
import { getQuote, getCompanyFilings } from '../services/finance-apis.js';
import { sendWhatsAppMessage } from '../services/whatsapp.js';
import { getEnv } from '../config/env.js';
import logger from '../utils/logger.js';

/**
 * Check all active stock price alerts against current market prices.
 * Runs during market hours (9:30am-4pm ET, weekdays) via cron.
 */
export async function checkPriceAlerts(): Promise<void> {
  // Guard: only run during actual market hours (9:30am-4pm ET)
  const now = new Date();
  const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const hour = etTime.getHours();
  const minute = etTime.getMinutes();
  if (hour < 9 || (hour === 9 && minute < 30) || hour >= 16) {
    return; // Outside market hours
  }

  const result = await query(
    `SELECT * FROM stock_watchlist WHERE status = 'active'`
  );

  if (result.rows.length === 0) return;

  // Dedupe tickers to minimize API calls
  const tickerMap = new Map<string, any[]>();
  for (const row of result.rows) {
    const existing = tickerMap.get(row.ticker) || [];
    existing.push(row);
    tickerMap.set(row.ticker, existing);
  }

  const phone = getEnv().JP_PHONE_NUMBER;

  for (const [ticker, alerts] of tickerMap) {
    try {
      const quoteData = await getQuote(ticker);
      if (!quoteData.c || quoteData.c === 0) continue;

      const currentPrice = quoteData.c;

      // Update current_price for all alerts on this ticker
      await query(
        `UPDATE stock_watchlist SET current_price = $1, updated_at = NOW() WHERE ticker = $2 AND status = 'active'`,
        [currentPrice, ticker]
      );

      for (const alert of alerts) {
        const refPrice = Number(alert.reference_price);
        const threshold = Number(alert.threshold);
        let triggered = false;
        let changePct = 0;
        let message = '';

        switch (alert.alert_type) {
          case 'drop_pct': {
            changePct = ((refPrice - currentPrice) / refPrice) * 100;
            if (changePct >= threshold) {
              triggered = true;
              message = `📉 *${alert.company_name || ticker}* dropped ${changePct.toFixed(1)}%\nFrom $${refPrice.toFixed(2)} → $${currentPrice.toFixed(2)}\nThreshold: ${threshold}% drop`;
            }
            break;
          }
          case 'rise_pct': {
            changePct = ((currentPrice - refPrice) / refPrice) * 100;
            if (changePct >= threshold) {
              triggered = true;
              message = `📈 *${alert.company_name || ticker}* rose ${changePct.toFixed(1)}%\nFrom $${refPrice.toFixed(2)} → $${currentPrice.toFixed(2)}\nThreshold: ${threshold}% rise`;
            }
            break;
          }
          case 'below_price': {
            changePct = ((refPrice - currentPrice) / refPrice) * 100;
            if (currentPrice <= threshold) {
              triggered = true;
              message = `⬇️ *${alert.company_name || ticker}* fell below $${threshold.toFixed(2)}\nCurrent: $${currentPrice.toFixed(2)}`;
            }
            break;
          }
          case 'above_price': {
            changePct = ((currentPrice - refPrice) / refPrice) * 100;
            if (currentPrice >= threshold) {
              triggered = true;
              message = `⬆️ *${alert.company_name || ticker}* rose above $${threshold.toFixed(2)}\nCurrent: $${currentPrice.toFixed(2)}`;
            }
            break;
          }
        }

        if (triggered) {
          // Send WhatsApp alert
          let messageSent = false;
          try {
            await sendWhatsAppMessage(phone, message);
            messageSent = true;
          } catch (err) {
            logger.error('Failed to send price alert', { error: err, ticker });
          }

          // Log to price_alerts
          await query(
            `INSERT INTO price_alerts (watchlist_id, ticker, alert_type, reference_price, triggered_price, threshold, change_pct, message_sent)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [alert.id, ticker, alert.alert_type, refPrice, currentPrice, threshold, changePct, messageSent]
          );

          // Update watchlist status
          if (alert.rearm) {
            // Rearm: reset reference price to current price
            await query(
              `UPDATE stock_watchlist SET reference_price = $1, updated_at = NOW() WHERE id = $2`,
              [currentPrice, alert.id]
            );
          } else {
            await query(
              `UPDATE stock_watchlist SET status = 'triggered', triggered_at = NOW(), updated_at = NOW() WHERE id = $1`,
              [alert.id]
            );
          }

          logger.info('Price alert triggered', { ticker, alert_type: alert.alert_type, changePct });
        }
      }
    } catch (err) {
      logger.error('Error checking price alert', { error: err, ticker });
    }
  }
}

/**
 * Check all watched companies for new SEC filings.
 * Runs during business hours (8am-6pm ET, weekdays) via cron.
 */
export async function checkSecFilings(): Promise<void> {
  const result = await query(
    `SELECT * FROM sec_watchlist WHERE status = 'active'`
  );

  if (result.rows.length === 0) return;

  const phone = getEnv().JP_PHONE_NUMBER;

  for (const watched of result.rows) {
    try {
      const filings = await getCompanyFilings(watched.cik);
      if (filings.length === 0) continue;

      // Find new filings since last check
      const lastDate = watched.last_filing_date ? new Date(watched.last_filing_date) : null;
      const watchedTypes = watched.filing_types as string[];

      const newFilings = filings.filter((f) => {
        const filingDate = new Date(f.filingDate);
        const isNew = !lastDate || filingDate > lastDate;
        const isWatchedType = watchedTypes.includes(f.form);
        return isNew && isWatchedType;
      });

      for (const filing of newFilings) {
        // Check if we already alerted on this filing
        const existing = await query(
          `SELECT id FROM filing_alerts WHERE accession_number = $1`,
          [filing.accessionNumber]
        );
        if (existing.rows.length > 0) continue;

        const formBadge = filing.form === '10-K' ? '📊' : filing.form === '10-Q' ? '📋' : filing.form === '8-K' ? '⚡' : '📄';
        const message = [
          `${formBadge} *New SEC Filing: ${watched.company_name || watched.ticker}*`,
          `*Form:* ${filing.form}`,
          `*Filed:* ${filing.filingDate}`,
          filing.primaryDocDescription ? `*Description:* ${filing.primaryDocDescription}` : '',
          `*Link:* ${filing.filingUrl}`,
        ].filter(Boolean).join('\n');

        // Send WhatsApp alert
        let messageSent = false;
        try {
          await sendWhatsAppMessage(phone, message);
          messageSent = true;
        } catch (err) {
          logger.error('Failed to send filing alert', { error: err, ticker: watched.ticker });
        }

        // Log to filing_alerts
        await query(
          `INSERT INTO filing_alerts (sec_watchlist_id, ticker, filing_type, accession_number, filing_date, filing_url, description, message_sent)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [watched.id, watched.ticker, filing.form, filing.accessionNumber, filing.filingDate, filing.filingUrl, filing.primaryDocDescription || '', messageSent]
        );

        logger.info('New SEC filing detected', { ticker: watched.ticker, form: filing.form });
      }

      // Update last_checked_at and last_filing_date
      const latestDate = filings[0]?.filingDate || null;
      await query(
        `UPDATE sec_watchlist SET last_checked_at = NOW(), last_filing_date = COALESCE($1, last_filing_date), updated_at = NOW() WHERE id = $2`,
        [latestDate, watched.id]
      );
    } catch (err) {
      logger.error('Error checking SEC filings', { error: err, ticker: watched.ticker });
    }
  }
}
