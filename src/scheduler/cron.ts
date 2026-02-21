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
import { checkPriceAlerts, checkSecFilings } from './finance-monitor.js';
import logger from '../utils/logger.js';

const tasks: cron.ScheduledTask[] = [];

export function startScheduler(): void {
  // Heartbeat: every 30 minutes during active hours (7am-11pm ET)
  tasks.push(
    cron.schedule('*/30 7-23 * * *', async () => {
      try {
        await runHeartbeat();
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
        // For recurring, calculate next run (handled by cron expression)
        await query(
          `UPDATE scheduled_tasks SET last_run_at = NOW(), run_count = run_count + 1 WHERE id = $1`,
          [task.id]
        );
      }

      logger.info('Scheduled task executed', { id: task.id, type: task.task_type });
    } catch (err) {
      logger.error('Failed to execute scheduled task', { id: task.id, error: err });
    }
  }
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
