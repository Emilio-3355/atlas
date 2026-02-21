import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { getEnv } from './config/env.js';
import { getPool, closePool } from './config/database.js';
import { connectRedis, closeRedis } from './config/redis.js';
import { requestLogger } from './middleware/request-logger.js';
import { registerBuiltInToolsAsync } from './tools/registry.js';
import { startScheduler, stopScheduler } from './scheduler/cron.js';
import whatsappRouter from './routes/whatsapp.js';
import healthRouter from './routes/health.js';
import gmailCallbackRouter from './routes/gmail-callback.js';
import logger from './utils/logger.js';

const app = new Hono();

// Global middleware
app.use('*', requestLogger);

// Routes
app.route('/webhook/whatsapp', whatsappRouter);
app.route('/health', healthRouter);
app.route('/auth/google/callback', gmailCallbackRouter);

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

  // Start scheduler
  startScheduler();

  // Start server
  const server = serve({ fetch: app.fetch, port: env.PORT }, () => {
    logger.info(`Atlas is alive on port ${env.PORT}`, { env: env.NODE_ENV });
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);

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
