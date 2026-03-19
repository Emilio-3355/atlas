import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { getEnv } from './config/env.js';
import { getPool, closePool } from './config/database.js';
import { connectRedis, closeRedis } from './config/redis.js';
import { requestLogger } from './middleware/request-logger.js';
import { registerBuiltInToolsAsync } from './tools/registry.js';
import { startScheduler, stopScheduler } from './scheduler/cron.js';
import whatsappRouter from './routes/whatsapp.js';
import telegramRouter from './routes/telegram.js';
import slackRouter from './routes/slack.js';
import healthRouter from './routes/health.js';
import gmailCallbackRouter from './routes/gmail-callback.js';
import voiceRouter from './routes/voice.js';
import logger from './utils/logger.js';
import { initDaemonBridge, closeDaemonBridge } from './services/daemon-bridge.js';
import dashboardRouter from './routes/dashboard-api.js';
import { initDashboardWS, closeDashboardWS } from './services/dashboard-ws.js';
import { isTelegramEnabled, getTelegramBot } from './services/telegram.js';
import { messageQueue } from './agent/message-queue.js';
import { processMessage } from './agent/core.js';
import { hookManager } from './hooks/manager.js';
import { smartErrorHandler } from './hooks/on-error.js';

// Wire up the message processing handler (central, not hidden in a route file)
messageQueue.setHandler(processMessage);

// Register hooks (error handling, learning from failures)
hookManager.registerOnError(smartErrorHandler);

const app = new Hono();

// Global middleware
app.use('*', requestLogger);

// Routes
app.route('/webhook/whatsapp', whatsappRouter);
app.route('/webhook/telegram', telegramRouter);
app.route('/webhook/slack', slackRouter);
app.route('/health', healthRouter);
app.route('/auth/google/callback', gmailCallbackRouter);
app.route('/control', dashboardRouter);

// Voice AI — Atlas answers calls and talks via Claude
app.route('/voice', voiceRouter);

// Serve voice files temporarily (for Twilio media)
app.get('/media/voice/:filename', async (c) => {
  const filename = c.req.param('filename');
  // Security: only allow alphanumeric + underscore + .mp3
  if (!/^[a-zA-Z0-9_]+\.mp3$/.test(filename)) {
    return c.text('Not found', 404);
  }
  const filePath = `/tmp/atlas-voice/${filename}`;
  try {
    const fs = await import('fs');
    if (!fs.existsSync(filePath)) return c.text('Not found', 404);
    const buffer = fs.readFileSync(filePath);
    return new Response(buffer, {
      headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(buffer.length) },
    });
  } catch {
    return c.text('Not found', 404);
  }
});

// Root
app.get('/', (c) => c.json({ name: 'Atlas', status: 'running', version: '1.0.0' }));

// Start
async function start() {
  const env = getEnv();

  // Connect to services
  logger.info('Connecting to PostgreSQL...');
  getPool(); // Initialize pool

  logger.info('Connecting to Redis...');
  await connectRedis();

  // Register tools
  await registerBuiltInToolsAsync();

  // Load dynamically-forged tools from database
  const { loadDynamicTools } = await import('./tools/registry.js');
  await loadDynamicTools();

  // Start scheduler
  startScheduler();

  // Start server
  const server = serve({ fetch: app.fetch, port: env.PORT }, () => {
    logger.info(`Atlas is alive on port ${env.PORT}`, { env: env.NODE_ENV });
  });

  // Initialize daemon bridge (WebSocket server for remote Mac control)
  if (env.DAEMON_SECRET) {
    initDaemonBridge(server as any);
  }

  // Initialize Telegram webhook (if token provided)
  if (isTelegramEnabled()) {
    try {
      const webhookUrl = `${env.BASE_URL}/webhook/telegram`;
      const bot = getTelegramBot();
      if (bot) {
        const webhookOpts: any = {};
        if (env.TELEGRAM_WEBHOOK_SECRET) {
          webhookOpts.secret_token = env.TELEGRAM_WEBHOOK_SECRET;
        }
        await bot.api.setWebhook(webhookUrl, webhookOpts);
        logger.info('Telegram webhook set', { url: webhookUrl, hasSecret: !!env.TELEGRAM_WEBHOOK_SECRET });
      }
    } catch (err) {
      logger.warn('Failed to set Telegram webhook (non-fatal)', { error: err });
    }
  }

  // Initialize dashboard WebSocket
  initDashboardWS(server as any);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);

    closeDaemonBridge();
    closeDashboardWS();
    server.close();
    stopScheduler();
    await closePool();
    await closeRedis();

    logger.info('Atlas shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  logger.error('Failed to start Atlas', { error: err });
  process.exit(1);
});
