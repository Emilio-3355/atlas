import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import OpenAI from 'openai';
import { getEnv } from '../config/env.js';
import logger from '../utils/logger.js';

const execFileAsync = promisify(execFile);

const TEMP_DIR = '/tmp/atlas-video';
const WHISPER_MAX_SIZE = 24 * 1024 * 1024; // 24MB (leave 1MB margin from 25MB limit)
const MAX_AUDIO_DURATION = 7200; // 2 hours max

// ─── URL Detection ──────────────────────────────────────────────

const YOUTUBE_REGEX = /(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/i;
const INSTAGRAM_REGEX = /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:reel|p|tv)\/([\w-]+)/i;

export interface VideoInfo {
  platform: 'youtube' | 'instagram' | 'telegram';
  videoId: string;
  url: string;
  title?: string;
  duration?: number;
}

export function detectVideoUrl(text: string): VideoInfo | null {
  const ytMatch = text.match(YOUTUBE_REGEX);
  if (ytMatch) {
    return {
      platform: 'youtube',
      videoId: ytMatch[1],
      url: `https://www.youtube.com/watch?v=${ytMatch[1]}`,
    };
  }

  const igMatch = text.match(INSTAGRAM_REGEX);
  if (igMatch) {
    return {
      platform: 'instagram',
      videoId: igMatch[1],
      url: `https://www.instagram.com/reel/${igMatch[1]}/`,
    };
  }

  return null;
}

export function containsVideoUrl(text: string): boolean {
  return YOUTUBE_REGEX.test(text) || INSTAGRAM_REGEX.test(text);
}

// ─── Audio Download ─────────────────────────────────────────────

function ensureTempDir() {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function tempPath(suffix: string): string {
  return path.join(TEMP_DIR, `${crypto.randomBytes(8).toString('hex')}${suffix}`);
}

/** Download audio from a YouTube or Instagram URL via yt-dlp */
export async function downloadAudio(url: string): Promise<{ filePath: string; title: string; duration: number }> {
  ensureTempDir();
  const outPath = tempPath('.mp3');

  logger.info('Downloading audio via yt-dlp', { url });

  try {
    // Get video info first
    const { stdout: infoJson } = await execFileAsync('yt-dlp', [
      '--dump-json', '--no-download', url,
    ], { timeout: 30_000 });

    const info = JSON.parse(infoJson);
    const title = info.title || 'Unknown';
    const duration = info.duration || 0;

    if (duration > MAX_AUDIO_DURATION) {
      throw new Error(`Video too long (${Math.round(duration / 60)} min). Max ${MAX_AUDIO_DURATION / 60} min.`);
    }

    // Download audio only
    await execFileAsync('yt-dlp', [
      '-x',                        // extract audio
      '--audio-format', 'mp3',     // convert to mp3
      '--audio-quality', '5',      // medium quality (smaller files)
      '-o', outPath,               // output path
      '--no-playlist',             // single video only
      '--max-filesize', '100m',    // safety limit
      url,
    ], { timeout: 120_000 });

    // yt-dlp may add extension, find the actual file
    const actualPath = fs.existsSync(outPath) ? outPath
      : fs.existsSync(outPath + '.mp3') ? outPath + '.mp3'
      : outPath;

    if (!fs.existsSync(actualPath)) {
      throw new Error('yt-dlp completed but audio file not found');
    }

    logger.info('Audio downloaded', { title, duration, sizeMB: (fs.statSync(actualPath).size / 1024 / 1024).toFixed(1) });

    return { filePath: actualPath, title, duration };
  } catch (err: any) {
    // Clean up on error
    try { fs.unlinkSync(outPath); } catch {}
    throw new Error(`Failed to download audio: ${err.message}`);
  }
}

/** Download audio from a Telegram video file */
export async function downloadTelegramVideo(fileId: string): Promise<{ filePath: string }> {
  ensureTempDir();

  const { Bot } = await import('grammy');
  const token = getEnv().TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Telegram bot not configured');

  const bot = new Bot(token);
  const file = await bot.api.getFile(fileId);
  const filePath = file.file_path;
  if (!filePath) throw new Error('Telegram file path not available');

  const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const response = await fetch(fileUrl);
  if (!response.ok) throw new Error(`Failed to download: ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  const ext = path.extname(filePath) || '.mp4';
  const localPath = tempPath(ext);
  fs.writeFileSync(localPath, buffer);

  // Convert to mp3 using ffmpeg
  const mp3Path = tempPath('.mp3');
  await execFileAsync('ffmpeg', [
    '-i', localPath,
    '-vn',                       // no video
    '-acodec', 'libmp3lame',
    '-q:a', '5',                 // medium quality
    '-y',                        // overwrite
    mp3Path,
  ], { timeout: 60_000 });

  // Clean up original
  try { fs.unlinkSync(localPath); } catch {}

  return { filePath: mp3Path };
}

// ─── Transcription ──────────────────────────────────────────────

/** Split audio into chunks if over Whisper's 25MB limit */
async function splitAudioIfNeeded(filePath: string): Promise<string[]> {
  const stat = fs.statSync(filePath);

  if (stat.size <= WHISPER_MAX_SIZE) {
    return [filePath];
  }

  // Split into chunks using ffmpeg
  const chunks: string[] = [];
  const totalSize = stat.size;
  const numChunks = Math.ceil(totalSize / WHISPER_MAX_SIZE);

  // Get duration
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', filePath,
  ], { timeout: 10_000 });
  const totalDuration = parseFloat(stdout.trim());
  const chunkDuration = Math.ceil(totalDuration / numChunks);

  for (let i = 0; i < numChunks; i++) {
    const chunkPath = tempPath(`_chunk${i}.mp3`);
    const startTime = i * chunkDuration;

    await execFileAsync('ffmpeg', [
      '-i', filePath,
      '-ss', String(startTime),
      '-t', String(chunkDuration),
      '-acodec', 'libmp3lame',
      '-q:a', '5',
      '-y',
      chunkPath,
    ], { timeout: 60_000 });

    if (fs.existsSync(chunkPath) && fs.statSync(chunkPath).size > 0) {
      chunks.push(chunkPath);
    }
  }

  logger.info('Audio split into chunks', { original: filePath, chunks: chunks.length });
  return chunks;
}

/** Transcribe audio file(s) via OpenAI Whisper */
export async function transcribeAudio(filePath: string): Promise<string> {
  const openai = new OpenAI({ apiKey: getEnv().OPENAI_API_KEY });
  const chunks = await splitAudioIfNeeded(filePath);

  const transcripts: string[] = [];

  for (const chunkPath of chunks) {
    const buffer = fs.readFileSync(chunkPath);
    const ext = path.extname(chunkPath).slice(1) || 'mp3';

    const transcription = await openai.audio.transcriptions.create({
      file: new File([buffer], `audio.${ext}`, { type: `audio/${ext}` }),
      model: 'whisper-1',
    });

    transcripts.push(transcription.text);
    logger.debug('Chunk transcribed', { chunk: chunkPath, length: transcription.text.length });
  }

  // Clean up chunk files (but not the original if it wasn't split)
  for (const chunkPath of chunks) {
    if (chunkPath !== filePath) {
      try { fs.unlinkSync(chunkPath); } catch {}
    }
  }

  return transcripts.join('\n\n');
}

// ─── Full Pipeline ──────────────────────────────────────────────

export interface VideoSummaryResult {
  title: string;
  platform: string;
  duration: number;
  transcript: string;
  url: string;
}

/** Full pipeline: URL → download → transcribe → return transcript */
export async function processVideoUrl(url: string): Promise<VideoSummaryResult> {
  const video = detectVideoUrl(url);
  if (!video) throw new Error('Not a recognized video URL');

  const { filePath, title, duration } = await downloadAudio(video.url);

  try {
    const transcript = await transcribeAudio(filePath);
    return { title, platform: video.platform, duration, transcript, url: video.url };
  } finally {
    // Clean up audio file
    try { fs.unlinkSync(filePath); } catch {}
  }
}

/** Process a Telegram-forwarded video file */
export async function processTelegramVideo(fileId: string): Promise<VideoSummaryResult> {
  const { filePath } = await downloadTelegramVideo(fileId);

  try {
    const transcript = await transcribeAudio(filePath);
    return {
      title: 'Telegram Video',
      platform: 'telegram',
      duration: 0,
      transcript,
      url: '',
    };
  } finally {
    try { fs.unlinkSync(filePath); } catch {}
  }
}

// ─── Cleanup ────────────────────────────────────────────────────

/** Clean up old temp files (called periodically) */
export function cleanupTempFiles(maxAgeMs: number = 3600_000): void {
  if (!fs.existsSync(TEMP_DIR)) return;
  const now = Date.now();
  for (const file of fs.readdirSync(TEMP_DIR)) {
    const fullPath = path.join(TEMP_DIR, file);
    try {
      const stat = fs.statSync(fullPath);
      if (now - stat.mtimeMs > maxAgeMs) fs.unlinkSync(fullPath);
    } catch {}
  }
}
