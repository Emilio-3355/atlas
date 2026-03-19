import { Hono } from 'hono';
import { processMessage } from '../agent/core.js';
import { isSlackEnabled, verifySlackSignature, sendSlackMessage } from '../services/slack.js';
import { getEnv } from '../config/env.js';
import { dashboardBus } from '../services/dashboard-events.js';
import logger from '../utils/logger.js';

const slackRouter = new Hono();

// Slack Events API endpoint
slackRouter.post('/', async (c) => {
  if (!isSlackEnabled()) {
    return c.json({ error: 'Slack not configured' }, 503);
  }

  const body = await c.req.text();
  const parsed = JSON.parse(body);

  // Handle URL verification challenge (Slack setup)
  if (parsed.type === 'url_verification') {
    return c.json({ challenge: parsed.challenge });
  }

  // Verify request signature
  const env = getEnv();
  const signingSecret = env.SLACK_SIGNING_SECRET;
  if (signingSecret) {
    const timestamp = c.req.header('x-slack-request-timestamp') || '';
    const signature = c.req.header('x-slack-signature') || '';

    // Reject requests older than 5 minutes
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - Number(timestamp)) > 300) {
      return c.json({ error: 'Request too old' }, 403);
    }

    if (!(await verifySlackSignature(signingSecret, timestamp, body, signature))) {
      logger.warn('Invalid Slack signature');
      return c.json({ error: 'Invalid signature' }, 403);
    }
  }

  // Handle events
  if (parsed.type === 'event_callback') {
    const event = parsed.event;

    // Only respond to messages, not bot messages or edits
    if (event.type === 'message' && !event.bot_id && !event.subtype) {
      const text = event.text || '';
      const channel = event.channel;
      const threadTs = event.thread_ts || event.ts;
      const userId = event.user;

      logger.info('Slack message received', { channel, user: userId, text: text.slice(0, 50) });
      dashboardBus.publish({ type: 'message_in', data: { phone: `slack:${userId}`, preview: text.slice(0, 100), channel: 'slack' } });

      // Process message asynchronously (don't block Slack's 3s timeout)
      processSlackMessage(text, channel, threadTs, userId).catch((err) => {
        logger.error('Slack message processing failed', { error: err });
      });
    }
  }

  // Acknowledge immediately (Slack requires <3s response)
  return c.json({ ok: true });
});

async function processSlackMessage(
  text: string,
  channel: string,
  threadTs: string,
  userId: string,
): Promise<void> {
  try {
    // Use the agent's processMessage with a slack: prefix identifier
    // For now, route through the same pipeline with 'slack' channel support
    // We use the channel+user as the phone identifier
    const slackId = `slack:${userId}`;

    // Process through Atlas core
    await processMessage(slackId, text, 'slack' as any);
  } catch (err) {
    logger.error('Failed to process Slack message', { error: err });
    // Send error response in thread
    await sendSlackMessage(channel, 'Sorry, I encountered an error processing that request.', threadTs);
  }
}

export default slackRouter;
