import { Hono } from 'hono';
import logger from '../utils/logger.js';

const gmailCallbackRouter = new Hono();

// OAuth2 callback for Gmail
gmailCallbackRouter.get('/', async (c) => {
  const code = c.req.query('code');
  const error = c.req.query('error');

  if (error) {
    logger.error('Gmail OAuth error', { error });
    return c.text(`OAuth error: ${error}`, 400);
  }

  if (!code) {
    return c.text('Missing authorization code', 400);
  }

  // Exchange code for tokens — Phase 2 will implement full Gmail service
  logger.info('Gmail OAuth callback received', { codeLength: code.length });

  return c.text('Gmail connected successfully. You can close this tab.', 200);
});

export default gmailCallbackRouter;
