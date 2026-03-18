import { query } from '../config/database.js';
import { searchEmails } from '../services/gmail.js';
import { getCalendarEvents } from '../services/gmail.js';
import { sendWhatsAppMessage } from '../services/whatsapp.js';
import { getEnv } from '../config/env.js';
import { dashboardBus } from '../services/dashboard-events.js';
import logger from '../utils/logger.js';

// ===== Types =====

interface HeartbeatSignal {
  type: 'urgent_email' | 'upcoming_event' | 'stale_approval' | 'price_alert' | 'overdue_task' | 'gap_accumulation' | 'upcoming_reminder';
  summary: string;
  priority: 'high' | 'medium' | 'low';
}

interface HeartbeatReport {
  signals: HeartbeatSignal[];
  checksRun: number;
  checksFailed: number;
  timestamp: Date;
}

// ===== Main Heartbeat =====

/**
 * Intelligent heartbeat — runs every 30min during active hours.
 * Checks multiple data sources, prioritizes signals, and only
 * bothers JP when something actually matters.
 */
export async function runHeartbeat(): Promise<HeartbeatReport> {
  const startTime = Date.now();
  logger.debug('Running intelligent heartbeat');

  const checks = await Promise.allSettled([
    checkPendingApprovals(),
    checkUpcomingReminders(),
    checkCalendarLookahead(),
    checkUrgentEmails(),
    checkFiredPriceAlerts(),
    checkOverdueTasks(),
    checkGapSignalAccumulation(),
  ]);

  const signals: HeartbeatSignal[] = [];
  let checksFailed = 0;

  for (const check of checks) {
    if (check.status === 'fulfilled' && check.value) {
      signals.push(...check.value);
    } else if (check.status === 'rejected') {
      checksFailed++;
    }
  }

  const report: HeartbeatReport = {
    signals,
    checksRun: checks.length,
    checksFailed,
    timestamp: new Date(),
  };

  // Publish to dashboard
  dashboardBus.publish({
    type: 'heartbeat',
    data: {
      signalCount: signals.length,
      highPriority: signals.filter(s => s.priority === 'high').length,
      checksRun: checks.length,
      checksFailed,
      durationMs: Date.now() - startTime,
    },
  });

  // Route signals based on priority
  if (signals.length > 0) {
    await routeSignals(signals);
  }

  return report;
}

// ===== Signal Routing =====

async function routeSignals(signals: HeartbeatSignal[]): Promise<void> {
  const phone = getEnv().JP_PHONE_NUMBER;
  const highPriority = signals.filter(s => s.priority === 'high');
  const mediumPriority = signals.filter(s => s.priority === 'medium');

  // High priority → immediate notification
  if (highPriority.length > 0) {
    let message = '🚨 *Atlas Heartbeat — Urgent*\n\n';
    for (const signal of highPriority) {
      message += `• ${signal.summary}\n`;
    }

    // Also include medium if we're already notifying
    if (mediumPriority.length > 0) {
      message += '\n📋 *Also noted:*\n';
      for (const signal of mediumPriority) {
        message += `• ${signal.summary}\n`;
      }
    }

    await sendWhatsAppMessage(phone, message);
    logger.info('Heartbeat: urgent notification sent', { signals: highPriority.length });
  }
  // Medium only → only notify if there are 3+ signals (batch threshold)
  else if (mediumPriority.length >= 3) {
    let message = '📋 *Atlas Heartbeat — Updates*\n\n';
    for (const signal of mediumPriority) {
      message += `• ${signal.summary}\n`;
    }
    await sendWhatsAppMessage(phone, message);
    logger.info('Heartbeat: batched notification sent', { signals: mediumPriority.length });
  }

  // Low priority → logged only, not sent
  const lowPriority = signals.filter(s => s.priority === 'low');
  if (lowPriority.length > 0) {
    logger.debug('Heartbeat: low-priority signals logged', {
      count: lowPriority.length,
      summaries: lowPriority.map(s => s.summary),
    });
  }
}

// ===== Individual Checks =====

async function checkPendingApprovals(): Promise<HeartbeatSignal[]> {
  const result = await query(
    `SELECT tool_name, created_at FROM pending_actions
     WHERE status = 'pending' AND created_at < NOW() - INTERVAL '15 minutes'`
  );

  if (result.rows.length === 0) return [];

  const staleMinutes = result.rows.map((r: any) => {
    const mins = Math.round((Date.now() - new Date(r.created_at).getTime()) / 60000);
    return `${r.tool_name} (${mins}min ago)`;
  });

  return [{
    type: 'stale_approval',
    summary: `${result.rows.length} action(s) awaiting approval: ${staleMinutes.join(', ')}`,
    priority: result.rows.length >= 3 ? 'high' : 'medium',
  }];
}

async function checkUpcomingReminders(): Promise<HeartbeatSignal[]> {
  const result = await query(
    `SELECT content, next_run_at FROM scheduled_tasks
     WHERE status = 'active' AND task_type = 'reminder'
     AND next_run_at BETWEEN NOW() AND NOW() + INTERVAL '35 minutes'`
  );

  return result.rows.map((r: any) => ({
    type: 'upcoming_reminder' as const,
    summary: `Reminder soon: ${r.content}`,
    priority: 'low' as const,
  }));
}

async function checkCalendarLookahead(): Promise<HeartbeatSignal[]> {
  try {
    const now = new Date();
    const in2hours = new Date(now.getTime() + 120 * 60 * 1000);
    const events = await getCalendarEvents(now.toISOString(), in2hours.toISOString(), 5);

    return events.map((e) => {
      const start = new Date(e.start);
      const minsUntil = Math.round((start.getTime() - now.getTime()) / 60000);
      const locationInfo = e.location ? ` at ${e.location}` : '';

      return {
        type: 'upcoming_event' as const,
        summary: `"${e.summary}" in ${minsUntil}min${locationInfo}`,
        priority: minsUntil <= 15 ? 'high' as const : minsUntil <= 45 ? 'medium' as const : 'low' as const,
      };
    });
  } catch {
    return [];
  }
}

async function checkUrgentEmails(): Promise<HeartbeatSignal[]> {
  try {
    const emails = await searchEmails('is:unread is:important newer_than:30m', 3);
    if (emails.length === 0) return [];

    return [{
      type: 'urgent_email',
      summary: `${emails.length} new important email(s): "${emails[0].subject}"${emails.length > 1 ? ` +${emails.length - 1} more` : ''}`,
      priority: 'high',
    }];
  } catch {
    return [];
  }
}

async function checkFiredPriceAlerts(): Promise<HeartbeatSignal[]> {
  try {
    const result = await query(
      `SELECT symbol, alert_type, target_price, triggered_price, triggered_at
       FROM price_alerts
       WHERE triggered_at > NOW() - INTERVAL '35 minutes'
         AND notified = false
       ORDER BY triggered_at DESC
       LIMIT 5`
    );

    if (result.rows.length === 0) return [];

    // Mark as notified
    const ids = result.rows.map((r: any) => r.id);
    if (ids.length > 0) {
      await query(
        `UPDATE price_alerts SET notified = true WHERE id = ANY($1)`,
        [ids]
      ).catch(() => {}); // Non-critical
    }

    const alerts = result.rows.map((r: any) =>
      `${r.symbol} ${r.alert_type} $${r.triggered_price} (target: $${r.target_price})`
    );

    return [{
      type: 'price_alert',
      summary: `Price alert(s) fired: ${alerts.join('; ')}`,
      priority: 'high',
    }];
  } catch {
    return [];
  }
}

async function checkOverdueTasks(): Promise<HeartbeatSignal[]> {
  try {
    const result = await query(
      `SELECT id, content, task_type, next_run_at FROM scheduled_tasks
       WHERE status = 'active'
         AND next_run_at < NOW() - INTERVAL '10 minutes'
         AND next_run_at > NOW() - INTERVAL '2 hours'
       LIMIT 5`
    );

    if (result.rows.length === 0) return [];

    return [{
      type: 'overdue_task',
      summary: `${result.rows.length} overdue task(s): ${result.rows.map((r: any) => r.content?.slice(0, 40)).join(', ')}`,
      priority: 'medium',
    }];
  } catch {
    return [];
  }
}

async function checkGapSignalAccumulation(): Promise<HeartbeatSignal[]> {
  try {
    // Check for gap signals (tool failures, unknown tool requests, etc.) in last 24h
    const result = await query(
      `SELECT COUNT(*) as gap_count FROM tool_usage
       WHERE success = false
         AND created_at > NOW() - INTERVAL '24 hours'`
    );

    const gapCount = Number(result.rows[0]?.gap_count || 0);

    if (gapCount >= 5) {
      // Get the most common failure
      const topFailure = await query(
        `SELECT tool_name, COUNT(*) as cnt, MAX(error_message) as last_error
         FROM tool_usage
         WHERE success = false AND created_at > NOW() - INTERVAL '24 hours'
         GROUP BY tool_name
         ORDER BY COUNT(*) DESC
         LIMIT 1`
      );

      const failInfo = topFailure.rows[0];
      const detail = failInfo
        ? ` (top: ${failInfo.tool_name} failed ${failInfo.cnt}x — "${failInfo.last_error?.slice(0, 60)}")`
        : '';

      return [{
        type: 'gap_accumulation',
        summary: `${gapCount} tool failures in last 24h${detail}. Consider reviewing or proposing fixes.`,
        priority: gapCount >= 10 ? 'high' : 'medium',
      }];
    }

    return [];
  } catch {
    return [];
  }
}
