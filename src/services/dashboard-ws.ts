import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { getEnv } from '../config/env.js';
import { dashboardBus, type DashboardEvent } from './dashboard-events.js';
import logger from '../utils/logger.js';

let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();

const HEARTBEAT_INTERVAL = 30_000;

export function initDashboardWS(httpServer: any): void {
  const token = getEnv().DASHBOARD_TOKEN;
  if (!token) {
    logger.info('DASHBOARD_TOKEN not set — dashboard WS in open mode (dev)');
  }

  wss = new WebSocketServer({ noServer: true });

  // Intercept upgrade requests on /ws/control
  httpServer.on('upgrade', (req: IncomingMessage, socket: any, head: Buffer) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    if (url.pathname !== '/ws/control') return; // let other handlers (daemon-bridge) handle

    // Token auth
    if (token) {
      const qToken = url.searchParams.get('token');
      if (qToken !== token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    wss!.handleUpgrade(req, socket, head, (ws) => {
      wss!.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws);
    logger.info('Dashboard WS client connected', { total: clients.size });

    // Ping/pong heartbeat
    const interval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, HEARTBEAT_INTERVAL);

    ws.on('pong', () => {
      // Client is alive
    });

    ws.on('close', () => {
      clearInterval(interval);
      clients.delete(ws);
      logger.info('Dashboard WS client disconnected', { total: clients.size });
    });

    ws.on('error', (err: Error) => {
      clearInterval(interval);
      clients.delete(ws);
      logger.error('Dashboard WS error', { error: err.message });
    });

    // Send welcome
    ws.send(JSON.stringify({ type: 'connected', ts: Date.now() }));
  });

  // Subscribe to event bus and broadcast
  dashboardBus.on('event', (event: DashboardEvent) => {
    const payload = JSON.stringify(event);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  });

  logger.info('Dashboard WebSocket initialized on /ws/control');
}

export function closeDashboardWS(): void {
  if (wss) {
    for (const ws of clients) ws.close();
    clients.clear();
    wss.close();
    wss = null;
    logger.info('Dashboard WebSocket closed');
  }
}

export function getDashboardClientCount(): number {
  return clients.size;
}
