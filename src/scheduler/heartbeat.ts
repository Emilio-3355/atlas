import { query } from '../config/database.js';
import { searchEmails } from '../services/gmail.js';
import { getCalendarEvents } from '../services/gmail.js';
import { sendWhatsAppMessage } from '../services/whatsapp.js';
import { getEnv } from '../config/env.js';
import logger from '../utils/logger.js';

interface HeartbeatAlert {
  type: string;
  message: string;
  priority: 'high' | 'medium' | 'low';
}

export async function runHeartbeat(): Promise<void> {
  logger.debug('Running heartbeat check');

  const checks = await Promise.allSettled([
    checkPendingApprovals(),
    checkUpcomingReminders(),
    checkCalendarLookahead(),
    checkUrgentEmails(),
  ]);

  const alerts: HeartbeatAlert[] = [];

  for (const check of checks) {
    if (check.status === 'fulfilled' && check.value) {
      alerts.push(...check.value);
    }
  }

  if (alerts.length > 0) {
    const phone = getEnv().JP_PHONE_NUMBER;
    const highPriority = alerts.filter((a) => a.priority === 'high');
    const others = alerts.filter((a) => a.priority !== 'high');

    let message = '';

    if (highPriority.length > 0) {
      message += '🚨 *Urgent:*\n';
      message += highPriority.map((a) => `• ${a.message}`).join('\n');
    }

    if (others.length > 0) {
      if (message) message += '\n\n';
      message += '📋 *Updates:*\n';
      message += others.map((a) => `• ${a.message}`).join('\n');
    }

    await sendWhatsAppMessage(phone, message);
    logger.info('Heartbeat alerts sent', { count: alerts.length });
  }
}

async function checkPendingApprovals(): Promise<HeartbeatAlert[]> {
  const result = await query(
    `SELECT tool_name, created_at FROM pending_actions
     WHERE status = 'pending' AND created_at < NOW() - INTERVAL '15 minutes'`
  );

  if (result.rows.length === 0) return [];

  return [{
    type: 'pending_approval',
    message: `${result.rows.length} action(s) awaiting your approval for 15+ minutes`,
    priority: 'medium',
  }];
}

async function checkUpcomingReminders(): Promise<HeartbeatAlert[]> {
  const result = await query(
    `SELECT content, next_run_at FROM scheduled_tasks
     WHERE status = 'active' AND task_type = 'reminder'
     AND next_run_at BETWEEN NOW() AND NOW() + INTERVAL '30 minutes'`
  );

  return result.rows.map((r: any) => ({
    type: 'upcoming_reminder',
    message: `Reminder coming up: ${r.content}`,
    priority: 'low' as const,
  }));
}

async function checkCalendarLookahead(): Promise<HeartbeatAlert[]> {
  try {
    const now = new Date();
    const in90min = new Date(now.getTime() + 90 * 60 * 1000);

    const events = await getCalendarEvents(now.toISOString(), in90min.toISOString(), 3);

    return events.map((e) => {
      const start = new Date(e.start);
      const minsUntil = Math.round((start.getTime() - now.getTime()) / 60000);

      return {
        type: 'calendar',
        message: `"${e.summary}" in ${minsUntil} minutes${e.location ? ` at ${e.location}` : ''}`,
        priority: minsUntil <= 15 ? 'high' as const : 'medium' as const,
      };
    });
  } catch {
    return [];
  }
}

async function checkUrgentEmails(): Promise<HeartbeatAlert[]> {
  try {
    const emails = await searchEmails('is:unread is:important newer_than:30m', 3);

    if (emails.length === 0) return [];

    return [{
      type: 'urgent_email',
      message: `${emails.length} new important email(s): "${emails[0].subject}"${emails.length > 1 ? ` and ${emails.length - 1} more` : ''}`,
      priority: 'high',
    }];
  } catch {
    return [];
  }
}
