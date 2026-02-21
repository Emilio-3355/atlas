import { google, type gmail_v1 } from 'googleapis';
import { getEnv } from '../config/env.js';
import logger from '../utils/logger.js';

let gmailClient: gmail_v1.Gmail | null = null;

function getOAuth2Client() {
  const env = getEnv();
  const oauth2 = new google.auth.OAuth2(
    env.GMAIL_CLIENT_ID,
    env.GMAIL_CLIENT_SECRET,
    env.GMAIL_REDIRECT_URI,
  );
  oauth2.setCredentials({ refresh_token: env.GMAIL_REFRESH_TOKEN });
  return oauth2;
}

function getGmail(): gmail_v1.Gmail {
  if (!gmailClient) {
    const auth = getOAuth2Client();
    gmailClient = google.gmail({ version: 'v1', auth });
  }
  return gmailClient;
}

export async function searchEmails(
  queryStr: string,
  maxResults: number = 10,
): Promise<Array<{ id: string; subject: string; from: string; snippet: string; date: string }>> {
  const gmail = getGmail();

  const res = await gmail.users.messages.list({
    userId: 'me',
    q: queryStr,
    maxResults,
  });

  if (!res.data.messages || res.data.messages.length === 0) return [];

  const emails = await Promise.all(
    res.data.messages.map(async (msg) => {
      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id!,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date'],
      });

      const headers = detail.data.payload?.headers || [];
      const getHeader = (name: string) => headers.find((h) => h.name === name)?.value || '';

      return {
        id: msg.id!,
        subject: getHeader('Subject'),
        from: getHeader('From'),
        snippet: detail.data.snippet || '',
        date: getHeader('Date'),
      };
    })
  );

  return emails;
}

export async function getEmailBody(messageId: string): Promise<string> {
  const gmail = getGmail();

  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  const payload = res.data.payload;
  if (!payload) return '';

  function extractText(part: gmail_v1.Schema$MessagePart): string {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return Buffer.from(part.body.data, 'base64').toString('utf-8');
    }
    if (part.parts) {
      return part.parts.map(extractText).join('');
    }
    return '';
  }

  return extractText(payload).slice(0, 5000);
}

export async function sendEmail(to: string, subject: string, body: string): Promise<string> {
  const gmail = getGmail();

  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
  ).toString('base64url');

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });

  logger.info('Email sent', { to, subject, messageId: res.data.id });
  return res.data.id || '';
}

export async function getCalendarEvents(
  timeMin: string,
  timeMax: string,
  maxResults: number = 10,
): Promise<Array<{ summary: string; start: string; end: string; location?: string }>> {
  const auth = getOAuth2Client();
  const calendar = google.calendar({ version: 'v3', auth });

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin,
    timeMax,
    maxResults,
    singleEvents: true,
    orderBy: 'startTime',
  });

  return (res.data.items || []).map((event) => ({
    summary: event.summary || 'No title',
    start: event.start?.dateTime || event.start?.date || '',
    end: event.end?.dateTime || event.end?.date || '',
    location: event.location || undefined,
  }));
}

export async function createCalendarEvent(
  summary: string,
  start: string,
  end: string,
  description?: string,
  location?: string,
): Promise<string> {
  const auth = getOAuth2Client();
  const calendar = google.calendar({ version: 'v3', auth });

  const res = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary,
      description,
      location,
      start: { dateTime: start, timeZone: 'America/New_York' },
      end: { dateTime: end, timeZone: 'America/New_York' },
    },
  });

  logger.info('Calendar event created', { summary, id: res.data.id });
  return res.data.id || '';
}

export async function getAuthUrl(): Promise<string> {
  const oauth2 = getOAuth2Client();
  return oauth2.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/calendar',
    ],
    prompt: 'consent',
  });
}
