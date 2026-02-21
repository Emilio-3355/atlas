import { getCalendarEvents } from '../services/gmail.js';
import { searchEmails } from '../services/gmail.js';
import { query } from '../config/database.js';
import { sendWhatsAppMessage } from '../services/whatsapp.js';
import { getEnv } from '../config/env.js';
import logger from '../utils/logger.js';

export async function generateMorningBriefing(): Promise<void> {
  const phone = getEnv().JP_PHONE_NUMBER;
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);

  const [events, emails, reminders] = await Promise.allSettled([
    getCalendarEvents(todayStart.toISOString(), todayEnd.toISOString(), 10),
    searchEmails('is:unread', 5),
    query(
      `SELECT content, next_run_at FROM scheduled_tasks
       WHERE status = 'active' AND task_type = 'reminder'
       AND next_run_at BETWEEN $1 AND $2
       ORDER BY next_run_at`,
      [todayStart.toISOString(), todayEnd.toISOString()]
    ),
  ]);

  const dayName = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });

  let briefing = `☀️ *Good morning, JP!*\n${dayName}\n\n`;

  // Calendar
  briefing += '*📅 Today\'s Schedule:*\n';
  if (events.status === 'fulfilled' && events.value.length > 0) {
    for (const event of events.value) {
      const time = new Date(event.start).toLocaleTimeString('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric',
        minute: '2-digit',
      });
      briefing += `• ${time} — ${event.summary}${event.location ? ` 📍 ${event.location}` : ''}\n`;
    }
  } else {
    briefing += '• No events scheduled\n';
  }

  // Emails
  briefing += '\n*📧 Unread Emails:*\n';
  if (emails.status === 'fulfilled' && emails.value.length > 0) {
    for (const email of emails.value.slice(0, 5)) {
      briefing += `• ${email.from.split('<')[0].trim()}: "${email.subject}"\n`;
    }
    if (emails.value.length > 5) {
      briefing += `  _...and ${emails.value.length - 5} more_\n`;
    }
  } else {
    briefing += '• Inbox zero! 🎉\n';
  }

  // Reminders
  if (reminders.status === 'fulfilled' && reminders.value.rows.length > 0) {
    briefing += '\n*⏰ Reminders Today:*\n';
    for (const r of reminders.value.rows) {
      const time = new Date(r.next_run_at).toLocaleTimeString('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric',
        minute: '2-digit',
      });
      briefing += `• ${time} — ${r.content}\n`;
    }
  }

  briefing += '\n_Have a great day! I\'m here if you need anything._';

  await sendWhatsAppMessage(phone, briefing);
  logger.info('Morning briefing sent');
}
