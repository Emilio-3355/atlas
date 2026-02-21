import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { randomUUID } from 'crypto';
import type { IncomingMessage } from 'http';
import { getEnv } from '../config/env.js';
import { query } from '../config/database.js';
import logger from '../utils/logger.js';

// --- Types ---

interface DaemonInfo {
  daemonId: string;
  hostname: string;
  connectedAt: Date;
  lastHeartbeat: Date;
  platform?: string;
  ip?: string;
}

interface PendingCommand {
  resolve: (result: DaemonResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  chunks: string[];
}

export interface DaemonResult {
  success: boolean;
  output: string;
  exitCode: number;
  duration: number;
}

// --- State ---

let wss: WebSocketServer | null = null;
let daemonSocket: WebSocket | null = null;
let daemonInfo: DaemonInfo | null = null;
let dbConnectionId: number | null = null;
const pendingCommands = new Map<string, PendingCommand>();

const HEARTBEAT_INTERVAL = 30_000; // 30s
const HEARTBEAT_TIMEOUT = 10_000; // 10s
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let pongReceived = true;

// --- Public API ---

export function initDaemonBridge(httpServer: any): void {
  const secret = getEnv().DAEMON_SECRET;
  if (!secret) {
    logger.info('DAEMON_SECRET not set — daemon bridge disabled');
    return;
  }

  wss = new WebSocketServer({ noServer: true });

  // Intercept upgrade requests on /ws/daemon
  httpServer.on('upgrade', (req: IncomingMessage, socket: any, head: Buffer) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    if (url.pathname !== '/ws/daemon') return;

    wss!.handleUpgrade(req, socket, head, (ws) => {
      wss!.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const ip = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    logger.info('Daemon connection attempt', { ip });

    let authenticated = false;

    // Auth timeout — must authenticate within 5s
    const authTimer = setTimeout(() => {
      if (!authenticated) {
        ws.close(4002, 'Auth timeout');
        logger.warn('Daemon auth timeout', { ip });
      }
    }, 5000);

    ws.on('message', async (raw: RawData) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.close(4003, 'Invalid JSON');
        return;
      }

      // Handle auth
      if (msg.type === 'auth') {
        clearTimeout(authTimer);

        if (msg.token !== secret) {
          ws.close(4001, 'Invalid token');
          logger.warn('Daemon auth failed — wrong token', { ip });
          return;
        }

        // If another daemon is connected, disconnect it
        if (daemonSocket && daemonSocket.readyState === WebSocket.OPEN) {
          daemonSocket.close(4004, 'Replaced by new connection');
          logger.info('Previous daemon replaced');
        }

        authenticated = true;
        daemonSocket = ws;
        daemonInfo = {
          daemonId: msg.daemonId || randomUUID(),
          hostname: msg.hostname || 'unknown',
          connectedAt: new Date(),
          lastHeartbeat: new Date(),
          platform: msg.platform,
          ip,
        };

        // Log connection to DB
        try {
          const row = await query(
            `INSERT INTO daemon_connections (daemon_id, hostname, ip_address, metadata)
             VALUES ($1, $2, $3, $4)
             RETURNING id`,
            [daemonInfo.daemonId, daemonInfo.hostname, ip, JSON.stringify({ platform: msg.platform })],
          );
          dbConnectionId = row.rows[0]?.id;
        } catch (err) {
          logger.error('Failed to log daemon connection', { error: err });
        }

        // Start heartbeat
        startHeartbeat(ws);

        ws.send(JSON.stringify({ type: 'auth_ok' }));
        logger.info('Daemon authenticated', { hostname: daemonInfo.hostname, ip });
        return;
      }

      if (!authenticated) {
        ws.close(4001, 'Not authenticated');
        return;
      }

      // Handle result
      if (msg.type === 'result') {
        const pending = pendingCommands.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          pendingCommands.delete(msg.id);
          pending.resolve({
            success: msg.success,
            output: msg.output || '',
            exitCode: msg.exitCode ?? (msg.success ? 0 : 1),
            duration: msg.duration || 0,
          });
        }
        return;
      }

      // Handle streaming chunks
      if (msg.type === 'chunk') {
        const pending = pendingCommands.get(msg.id);
        if (pending) {
          pending.chunks.push(msg.data);
        }
        return;
      }

      // Handle done (after streaming)
      if (msg.type === 'done') {
        const pending = pendingCommands.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          pendingCommands.delete(msg.id);
          const output = pending.chunks.join('');
          pending.resolve({
            success: msg.success,
            output: output || msg.output || '',
            exitCode: msg.exitCode ?? (msg.success ? 0 : 1),
            duration: msg.duration || 0,
          });
        }
        return;
      }

      // Handle pong
      if (msg.type === 'pong') {
        pongReceived = true;
        if (daemonInfo) daemonInfo.lastHeartbeat = new Date();
        return;
      }
    });

    ws.on('close', async () => {
      if (ws === daemonSocket) {
        logger.info('Daemon disconnected', { hostname: daemonInfo?.hostname });
        stopHeartbeat();

        // Update DB
        if (dbConnectionId) {
          try {
            await query(
              `UPDATE daemon_connections SET disconnected_at = NOW() WHERE id = $1`,
              [dbConnectionId],
            );
          } catch (err) {
            logger.error('Failed to log daemon disconnect', { error: err });
          }
          dbConnectionId = null;
        }

        // Reject all pending commands
        for (const [id, pending] of pendingCommands) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Daemon disconnected'));
          pendingCommands.delete(id);
        }

        daemonSocket = null;
        daemonInfo = null;
      }
    });

    ws.on('error', (err: Error) => {
      logger.error('Daemon WebSocket error', { error: err });
    });
  });

  logger.info('Daemon bridge initialized on /ws/daemon');
}

export function isDaemonOnline(): boolean {
  return daemonSocket !== null && daemonSocket.readyState === WebSocket.OPEN;
}

export function getDaemonInfo(): DaemonInfo | null {
  return daemonInfo;
}

export function sendCommand(cmd: {
  action: string;
  command?: string;
  prompt?: string;
  directory?: string;
  timeout?: number;
}): Promise<DaemonResult> {
  return new Promise((resolve, reject) => {
    if (!isDaemonOnline()) {
      reject(new Error('Daemon is offline'));
      return;
    }

    const id = randomUUID();
    const timeout = (cmd.timeout || 120) * 1000;

    const timer = setTimeout(() => {
      pendingCommands.delete(id);
      reject(new Error(`Command timed out after ${cmd.timeout || 120}s`));
    }, timeout);

    pendingCommands.set(id, { resolve, reject, timer, chunks: [] });

    daemonSocket!.send(
      JSON.stringify({
        type: 'command',
        id,
        action: cmd.action,
        payload: {
          command: cmd.command,
          prompt: cmd.prompt,
          directory: cmd.directory,
          timeout: cmd.timeout,
        },
      }),
    );
  });
}

export function closeDaemonBridge(): void {
  stopHeartbeat();

  for (const [id, pending] of pendingCommands) {
    clearTimeout(pending.timer);
    pending.reject(new Error('Bridge closing'));
    pendingCommands.delete(id);
  }

  if (daemonSocket && daemonSocket.readyState === WebSocket.OPEN) {
    daemonSocket.close(1000, 'Server shutting down');
  }

  if (wss) {
    wss.close();
    wss = null;
  }

  daemonSocket = null;
  daemonInfo = null;
  logger.info('Daemon bridge closed');
}

// --- Heartbeat ---

function startHeartbeat(ws: WebSocket): void {
  stopHeartbeat();
  pongReceived = true;

  heartbeatTimer = setInterval(() => {
    if (!pongReceived) {
      logger.warn('Daemon missed heartbeat — disconnecting');
      ws.close(4005, 'Heartbeat timeout');
      return;
    }

    pongReceived = false;
    ws.send(JSON.stringify({ type: 'ping' }));
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}
