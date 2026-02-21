import { query } from '../config/database.js';
import { upsertFact, getFact } from '../memory/structured.js';
import logger from '../utils/logger.js';

interface ActivityPattern {
  hour: number;
  dayOfWeek: number;
  messageCount: number;
}

// Analyze JP's messaging patterns to learn active hours and preferences
export async function analyzeActivityPatterns(): Promise<void> {
  // Get message timestamps from the last 30 days
  const result = await query(
    `SELECT
       EXTRACT(HOUR FROM created_at AT TIME ZONE 'America/New_York') AS hour,
       EXTRACT(DOW FROM created_at AT TIME ZONE 'America/New_York') AS day_of_week,
       COUNT(*) AS message_count
     FROM messages
     WHERE role = 'user' AND created_at > NOW() - INTERVAL '30 days'
     GROUP BY hour, day_of_week
     ORDER BY message_count DESC`
  );

  if (result.rows.length === 0) return;

  const patterns: ActivityPattern[] = result.rows.map((r: any) => ({
    hour: Number(r.hour),
    dayOfWeek: Number(r.day_of_week),
    messageCount: Number(r.message_count),
  }));

  // Determine active hours (hours with at least 10% of max activity)
  const maxCount = Math.max(...patterns.map((p) => p.messageCount));
  const threshold = maxCount * 0.1;
  const activeHours = [...new Set(
    patterns.filter((p) => p.messageCount >= threshold).map((p) => p.hour)
  )].sort((a, b) => a - b);

  // Peak hours (top 3 most active)
  const peakHours = [...new Set(
    patterns.sort((a, b) => b.messageCount - a.messageCount)
      .slice(0, 5)
      .map((p) => p.hour)
  )].sort((a, b) => a - b);

  // Store patterns as structured facts
  await upsertFact('schedule_pattern', 'active_hours', JSON.stringify(activeHours), 'inferred', 0.8);
  await upsertFact('schedule_pattern', 'peak_hours', JSON.stringify(peakHours), 'inferred', 0.8);

  // Determine quiet hours (for suppressing non-urgent notifications)
  const allHours = Array.from({ length: 24 }, (_, i) => i);
  const quietHours = allHours.filter((h) => !activeHours.includes(h));
  await upsertFact('schedule_pattern', 'quiet_hours', JSON.stringify(quietHours), 'inferred', 0.7);

  logger.info('Activity patterns analyzed', { activeHours, peakHours, quietHours });
}

export async function isQuietHour(): Promise<boolean> {
  const fact = await getFact('schedule_pattern', 'quiet_hours');
  if (!fact) return false;

  const quietHours: number[] = JSON.parse(fact.value);
  const currentHour = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hour12: false,
  });

  return quietHours.includes(Number(currentHour));
}
