import { config } from 'dotenv';
import WebSocket from 'ws';
import { exec, spawn } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';

// Load .env from daemon directory
config({ path: new URL('./.env', import.meta.url).pathname });

// --- Config ---

const WS_URL = process.env.ATLAS_WS_URL || 'wss://atlas-production-9931.up.railway.app/ws/daemon';
const SECRET = process.env.DAEMON_SECRET || '';
const ALLOWED_PATHS = (process.env.ALLOWED_PATHS || '/Users/juanpabloperalta').split(',').map((p) => p.trim());

if (!SECRET) {
  console.error('[FATAL] DAEMON_SECRET is required');
  process.exit(1);
}

// --- Constants ---

const MAX_OUTPUT = 100 * 1024; // 100KB
const MAX_CONCURRENT = 3;
const RECONNECT_MIN = 1000;
const RECONNECT_MAX = 60000;

const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\//i,
  /sudo/i,
  /chmod\s+777/i,
  /curl.*\|.*sh/i,
  /wget.*\|.*sh/i,
  /eval\s*\(/i,
  />\s*\/etc\//i,
  /mkfs/i,
  /dd\s+if=/i,
  /shutdown/i,
  /reboot/i,
  /kill\s+-9\s+1\b/i,
  /:(){ :\|:& };:/,
  /format\s+c:/i,
];

// --- State ---

let ws: WebSocket | null = null;
let reconnectDelay = RECONNECT_MIN;
let activeCommands = 0;
let shouldReconnect = true;

// --- Helpers ---

function log(level: string, msg: string, data?: any) {
  const ts = new Date().toISOString();
  const extra = data ? ' ' + JSON.stringify(data) : '';
  console.log(`[${ts}] [${level.toUpperCase()}] ${msg}${extra}`);
}

function isPathAllowed(targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  return ALLOWED_PATHS.some((base) => resolved.startsWith(base));
}

function isCommandSafe(cmd: string): { safe: boolean; reason?: string } {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(cmd)) {
      return { safe: false, reason: `Blocked pattern: ${pattern.source}` };
    }
  }
  return { safe: true };
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + '\n\n[Output truncated]';
}

// --- Command Handlers ---

function handleShell(
  id: string,
  payload: { command: string; directory?: string; timeout?: number },
): void {
  const { command, directory, timeout = 120 } = payload;

  const safety = isCommandSafe(command);
  if (!safety.safe) {
    sendResult(id, false, safety.reason!, 1, 0);
    return;
  }

  if (directory && !isPathAllowed(directory)) {
    sendResult(id, false, `Path not allowed: ${directory}`, 1, 0);
    return;
  }

  const startTime = Date.now();
  const timeoutMs = Math.min(timeout, 120) * 1000;

  exec(command, {
    cwd: directory || os.homedir(),
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT,
  }, (error, stdout, stderr) => {
    const duration = Date.now() - startTime;
    let output = stdout || '';
    if (stderr) output += (output ? '\n--- stderr ---\n' : '') + stderr;
    output = truncate(output, MAX_OUTPUT);

    const timedOut = error?.killed === true;
    if (timedOut) output += '\n\n[Command timed out]';

    const exitCode = timedOut ? -1 : (error?.code ?? 0);
    sendResult(id, !error || exitCode === 0, output, typeof exitCode === 'number' ? exitCode : 1, duration);
    activeCommands--;
  });
}

function handleClaudeCode(
  id: string,
  payload: { prompt: string; directory?: string; timeout?: number },
): void {
  const { prompt, directory, timeout = 300 } = payload;

  if (directory && !isPathAllowed(directory)) {
    sendResult(id, false, `Path not allowed: ${directory}`, 1, 0);
    return;
  }

  const cwd = directory || os.homedir();
  if (!fs.existsSync(cwd)) {
    sendResult(id, false, `Directory not found: ${cwd}`, 1, 0);
    return;
  }

  const startTime = Date.now();
  const timeoutMs = Math.min(timeout, 300) * 1000;
  let output = '';
  let timedOut = false;

  const child = spawn('claude', ['-p', prompt, '--output-format', 'text'], {
    cwd,
    timeout: timeoutMs,
    env: {
      ...process.env,
      CLAUDE_CODE_ENTRYPOINT: 'atlas-daemon',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (data: Buffer) => {
    const chunk = data.toString();
    output += chunk;
    // Stream chunks to server
    sendChunk(id, chunk);
  });

  child.stderr.on('data', (data: Buffer) => {
    output += data.toString();
  });

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, timeoutMs);

  child.on('close', (code) => {
    clearTimeout(timer);
    const duration = Date.now() - startTime;
    output = truncate(output, MAX_OUTPUT);

    if (timedOut) output += '\n\n[Claude Code timed out]';

    sendDone(id, !timedOut && code === 0, output, code ?? 1, duration);
    activeCommands--;
  });

  child.on('error', (err) => {
    clearTimeout(timer);
    const duration = Date.now() - startTime;
    sendResult(id, false, `Failed to spawn Claude Code: ${err.message}`, 1, duration);
    activeCommands--;
  });
}

function handlePing(id: string): void {
  const info = {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    uptime: `${Math.floor(os.uptime() / 3600)}h ${Math.floor((os.uptime() % 3600) / 60)}m`,
    memory: {
      free: `${Math.round(os.freemem() / 1024 / 1024)}MB`,
      total: `${Math.round(os.totalmem() / 1024 / 1024)}MB`,
    },
    activeCommands,
  };
  send({ type: 'result', id, success: true, output: JSON.stringify(info), exitCode: 0, duration: 0 });
}

// --- WebSocket Helpers ---

function send(msg: any): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function sendResult(id: string, success: boolean, output: string, exitCode: number, duration: number): void {
  send({ type: 'result', id, success, output, exitCode, duration });
}

function sendChunk(id: string, data: string): void {
  send({ type: 'chunk', id, data });
}

function sendDone(id: string, success: boolean, output: string, exitCode: number, duration: number): void {
  send({ type: 'done', id, success, output, exitCode, duration });
}

// --- Connection ---

function connect(): void {
  log('info', `Connecting to ${WS_URL}...`);

  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    log('info', 'Connected — authenticating...');
    reconnectDelay = RECONNECT_MIN;

    // Send auth
    send({
      type: 'auth',
      token: SECRET,
      daemonId: `mac-${os.hostname()}`,
      hostname: os.hostname(),
      platform: os.platform(),
    });
  });

  ws.on('message', (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      log('warn', 'Invalid JSON from server');
      return;
    }

    // Auth response
    if (msg.type === 'auth_ok') {
      log('info', 'Authenticated successfully');
      return;
    }

    // Heartbeat ping
    if (msg.type === 'ping') {
      send({ type: 'pong' });
      return;
    }

    // Command
    if (msg.type === 'command') {
      if (activeCommands >= MAX_CONCURRENT) {
        sendResult(msg.id, false, `Too many concurrent commands (max ${MAX_CONCURRENT})`, 1, 0);
        return;
      }

      activeCommands++;
      const { action, payload } = msg;

      log('info', `Command: ${action}`, { id: msg.id, payload });

      switch (action) {
        case 'shell':
          handleShell(msg.id, payload);
          break;
        case 'claude_code':
          handleClaudeCode(msg.id, payload);
          break;
        case 'ping':
          handlePing(msg.id);
          activeCommands--;
          break;
        default:
          sendResult(msg.id, false, `Unknown action: ${action}`, 1, 0);
          activeCommands--;
      }
      return;
    }
  });

  ws.on('close', (code, reason) => {
    log('info', `Disconnected: ${code} ${reason.toString()}`);
    ws = null;

    if (shouldReconnect) {
      log('info', `Reconnecting in ${reconnectDelay / 1000}s...`);
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
    }
  });

  ws.on('error', (err) => {
    log('error', `WebSocket error: ${err.message}`);
  });
}

// --- Shutdown ---

process.on('SIGTERM', () => {
  log('info', 'SIGTERM received');
  shouldReconnect = false;
  ws?.close(1000, 'Daemon stopping');
  process.exit(0);
});

process.on('SIGINT', () => {
  log('info', 'SIGINT received');
  shouldReconnect = false;
  ws?.close(1000, 'Daemon stopping');
  process.exit(0);
});

// --- Start ---

log('info', `Atlas Daemon starting on ${os.hostname()} (${os.platform()})`);
log('info', `Allowed paths: ${ALLOWED_PATHS.join(', ')}`);
connect();
