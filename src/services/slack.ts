import logger from '../utils/logger.js';
import { getEnv } from '../config/env.js';

// Slack Web API client using fetch (no extra dependency)
class SlackClient {
  private token: string;
  private baseUrl = 'https://slack.com/api';

  constructor(token: string) {
    this.token = token;
  }

  async post(method: string, body: Record<string, any>): Promise<any> {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await response.json() as Record<string, any>;
    if (!data.ok) {
      logger.error('Slack API error', { method, error: data.error });
      throw new Error(`Slack API error: ${data.error as string}`);
    }
    return data;
  }
}

let slackClient: SlackClient | null = null;

export function isSlackEnabled(): boolean {
  try {
    const env = getEnv();
    return !!env.SLACK_BOT_TOKEN;
  } catch {
    return false;
  }
}

function getSlackClient(): SlackClient {
  if (!slackClient) {
    const env = getEnv();
    const token = env.SLACK_BOT_TOKEN;
    if (!token) throw new Error('SLACK_BOT_TOKEN not configured');
    slackClient = new SlackClient(token);
  }
  return slackClient;
}

/**
 * Send a message to a Slack channel or DM.
 */
export async function sendSlackMessage(
  channel: string,
  text: string,
  threadTs?: string,
): Promise<string> {
  const client = getSlackClient();
  const payload: Record<string, any> = { channel, text };
  if (threadTs) payload.thread_ts = threadTs;

  const result = await client.post('chat.postMessage', payload);
  logger.debug('Slack message sent', { channel, ts: result.ts });
  return result.ts;
}

/**
 * Send an image to a Slack channel.
 */
export async function sendSlackImage(
  channel: string,
  imageUrl: string,
  caption?: string,
  threadTs?: string,
): Promise<string> {
  const client = getSlackClient();
  const blocks = [
    {
      type: 'image',
      image_url: imageUrl,
      alt_text: caption || 'Atlas image',
      ...(caption ? { title: { type: 'plain_text', text: caption } } : {}),
    },
  ];

  const payload: Record<string, any> = {
    channel,
    text: caption || 'Image',
    blocks,
  };
  if (threadTs) payload.thread_ts = threadTs;

  const result = await client.post('chat.postMessage', payload);
  return result.ts;
}

/**
 * Verify a Slack request signature.
 */
export async function verifySlackSignature(
  signingSecret: string,
  requestTimestamp: string,
  requestBody: string,
  signature: string,
): Promise<boolean> {
  const crypto = await import('crypto');
  const baseString = `v0:${requestTimestamp}:${requestBody}`;
  const hmac = crypto.createHmac('sha256', signingSecret).update(baseString).digest('hex');
  const computed = `v0=${hmac}`;
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
}
