import cron from 'node-cron';
import { query } from '../config/database.js';
import { sendWhatsAppMessage } from '../services/whatsapp.js';
import { getEnv } from '../config/env.js';
import { runHeartbeat } from './heartbeat.js';
import { generateMorningBriefing } from './morning-briefing.js';
import { runEvolutionCycle } from '../self-improvement/evolver.js';
import { analyzeActivityPatterns } from './adaptive.js';
import { promoteLearnings } from '../self-improvement/promoter.js';
import { detectStaleness } from '../self-improvement/staleness-detector.js';
import { runFoundryAnalysis } from '../self-improvement/foundry.js';
import { checkPriceAlerts, checkSecFilings } from './finance-monitor.js';
import { dashboardBus } from '../services/dashboard-events.js';
import logger from '../utils/logger.js';

const tasks: cron.ScheduledTask[] = [];

export function startScheduler(): void {
  // Heartbeat: every 30 minutes during active hours (7am-11pm ET)
  tasks.push(
    cron.schedule('*/30 7-23 * * *', async () => {
      try {
        await runHeartbeat();
        dashboardBus.publish({ type: 'cron_fired', data: { job: 'Heartbeat' } });
      } catch (err) {
        logger.error('Heartbeat failed', { error: err });
      }
    }, { timezone: 'America/New_York' })
  );

  // Morning briefing: 7:30am ET weekdays
  tasks.push(
    cron.schedule('30 7 * * 1-5', async () => {
      try {
        await generateMorningBriefing();
        dashboardBus.publish({ type: 'cron_fired', data: { job: 'Morning Briefing' } });
      } catch (err) {
        logger.error('Morning briefing failed', { error: err });
      }
    }, { timezone: 'America/New_York' })
  );

  // Check for due one-shot tasks: every minute
  tasks.push(
    cron.schedule('* * * * *', async () => {
      try {
        await executeDueTasks();
      } catch (err) {
        logger.error('Due task check failed', { error: err });
        dashboardBus.publish({ type: 'error', data: { source: 'cron:due_tasks', message: String(err) } });
      }
    })
  );

  // Expire old pending actions: every 5 minutes
  tasks.push(
    cron.schedule('*/5 * * * *', async () => {
      try {
        await expirePendingActions();
      } catch (err) {
        logger.error('Action expiry failed', { error: err });
      }
    })
  );

  // Capability Evolution: daily at 10pm ET
  tasks.push(
    cron.schedule('0 22 * * *', async () => {
      try {
        await runEvolutionCycle();
        dashboardBus.publish({ type: 'cron_fired', data: { job: 'Evolution' } });
      } catch (err) {
        logger.error('Evolution cycle failed', { error: err });
      }
    }, { timezone: 'America/New_York' })
  );

  // Activity pattern analysis: daily at midnight ET
  tasks.push(
    cron.schedule('0 0 * * *', async () => {
      try {
        await analyzeActivityPatterns();
        await promoteLearnings();
        await detectStaleness();
        await runFoundryAnalysis();
        dashboardBus.publish({ type: 'cron_fired', data: { job: 'Patterns' } });
      } catch (err) {
        logger.error('Pattern analysis failed', { error: err });
      }
    }, { timezone: 'America/New_York' })
  );

  // Price alerts: every 5 min during market hours (9-4 ET, weekdays)
  // The function itself guards for 9:30am start
  tasks.push(
    cron.schedule('*/5 9-16 * * 1-5', async () => {
      try {
        await checkPriceAlerts();
        dashboardBus.publish({ type: 'cron_fired', data: { job: 'Price Alerts' } });
      } catch (err) {
        logger.error('Price alerts check failed', { error: err });
      }
    }, { timezone: 'America/New_York' })
  );

  // SEC filing check: every 30 min during business hours (8am-6pm ET, weekdays)
  tasks.push(
    cron.schedule('*/30 8-18 * * 1-5', async () => {
      try {
        await checkSecFilings();
        dashboardBus.publish({ type: 'cron_fired', data: { job: 'SEC Filings' } });
      } catch (err) {
        logger.error('SEC filing check failed', { error: err });
      }
    }, { timezone: 'America/New_York' })
  );

  logger.info(`Scheduler started with ${tasks.length} cron jobs`);
}

export function stopScheduler(): void {
  for (const task of tasks) {
    task.stop();
  }
  tasks.length = 0;
  logger.info('Scheduler stopped');
}

async function executeDueTasks(): Promise<void> {
  const result = await query(
    `SELECT * FROM scheduled_tasks
     WHERE status = 'active' AND next_run_at <= NOW()
     ORDER BY next_run_at ASC LIMIT 10`
  );

  for (const task of result.rows) {
    try {
      if (task.delivery === 'whatsapp') {
        const phone = getEnv().JP_PHONE_NUMBER;
        const prefix = task.task_type === 'reminder' ? '⏰ *Reminder:*' : '📋 *Scheduled:*';
        await sendWhatsAppMessage(phone, `${prefix} ${task.content}`);
      }

      // Update task
      if (task.schedule_type === 'one_shot') {
        await query(
          `UPDATE scheduled_tasks SET status = 'completed', last_run_at = NOW(), run_count = run_count + 1 WHERE id = $1`,
          [task.id]
        );
      } else {
        // For recurring, calculate next run from cron expression
        let nextRun: Date | null = null;
        if (task.cron_expression) {
          // Use node-cron to validate, then calculate next occurrence
          const interval = cron.validate(task.cron_expression)
            ? getNextCronRun(task.cron_expression)
            : null;
          nextRun = interval;
        } else if (task.interval_ms) {
          nextRun = new Date(Date.now() + task.interval_ms);
        }

        await query(
          `UPDATE scheduled_tasks SET last_run_at = NOW(), run_count = run_count + 1, next_run_at = $2 WHERE id = $1`,
          [task.id, nextRun || new Date(Date.now() + 86400_000)], // fallback: 24h
        );
      }

      dashboardBus.publish({ type: 'task_fired', data: { id: task.id, taskType: task.task_type, content: task.content?.slice(0, 80) } });
      logger.info('Scheduled task executed', { id: task.id, type: task.task_type });
    } catch (err) {
      logger.error('Failed to execute scheduled task', { id: task.id, error: err });
    }
  }
}

/** Calculate next cron run by checking minute-by-minute for the next 48 hours */
function getNextCronRun(cronExpression: string): Date | null {
  // node-cron doesn't expose a "next occurrence" API, so we check intervals
  const now = new Date();
  const check = new Date(now.getTime() + 60_000); // start from next minute
  check.setSeconds(0, 0);

  for (let i = 0; i < 2880; i++) { // 48 hours of minutes
    const m = check.getMinutes();
    const h = check.getHours();
    const dom = check.getDate();
    const mon = check.getMonth() + 1;
    const dow = check.getDay();

    // Parse cron: min hour dom month dow
    const parts = cronExpression.split(' ');
    if (parts.length >= 5) {
      const matchField = (field: string, value: number, max: number): boolean => {
        if (field === '*') return true;
        if (field.startsWith('*/')) {
          const step = parseInt(field.slice(2), 10);
          return value % step === 0;
        }
        if (field.includes(',')) return field.split(',').map(Number).includes(value);
        if (field.includes('-')) {
          const [lo, hi] = field.split('-').map(Number);
          return value >= lo && value <= hi;
        }
        return parseInt(field, 10) === value;
      };

      if (
        matchField(parts[0], m, 59) &&
        matchField(parts[1], h, 23) &&
        matchField(parts[2], dom, 31) &&
        matchField(parts[3], mon, 12) &&
        matchField(parts[4], dow, 6)
      ) {
        return check;
      }
    }

    check.setTime(check.getTime() + 60_000);
  }
  return null;
}

async function expirePendingActions(): Promise<void> {
  const result = await query(
    `UPDATE pending_actions SET status = 'expired', resolved_at = NOW()
     WHERE status = 'pending' AND expires_at < NOW()
     RETURNING id`
  );

  if (result.rowCount && result.rowCount > 0) {
    logger.info(`Expired ${result.rowCount} pending actions`);

    // Notify JP about expired actions
    const phone = getEnv().JP_PHONE_NUMBER;
    await sendWhatsAppMessage(phone, `${result.rowCount} pending action(s) expired without response.`);
  }
}
