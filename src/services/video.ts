import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import OpenAI from 'openai';
import { getEnv } from '../config/env.js';
import { getTelegramBot } from './telegram.js';
import logger from '../utils/logger.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const TEMP_DIR = '/tmp/atlas-video';
const WHISPER_MAX_SIZE = 24 * 1024 * 1024; // 24MB (Whisper limit is 25MB)
const MAX_AUDIO_DURATION = 7200; // 2 hours

// ─── URL Detection ──────────────────────────────────────────────

const YOUTUBE_REGEX = /(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/i;
const INSTAGRAM_REGEX = /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:reel|p|tv)\/([\w-]+)/i;

export interface VideoInfo {
  platform: 'youtube' | 'instagram' | 'telegram';
  videoId: string;
  url: string;
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

// ─── Helpers ────────────────────────────────────────────────────

function ensureTempDir() {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function tempPath(suffix: string): string {
  return path.join(TEMP_DIR, `${crypto.randomBytes(8).toString('hex')}${suffix}`);
}

async function isAvailable(cmd: string): Promise<boolean> {
  try {
    await execAsync(`which ${cmd}`, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function safeDelete(filePath: string) {
  try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
}

// ─── YouTube Subtitles (fast path — no download needed) ─────────

/**
 * Try to get YouTube subtitles/captions via yt-dlp.
 * Returns the subtitle text if available, null otherwise.
 */
async function getYouTubeSubtitles(url: string): Promise<{ text: string; title: string; duration: number } | null> {
  if (!(await isAvailable('yt-dlp'))) return null;

  ensureTempDir();
  const basePath = tempPath('_subs');

  try {
    // Get video info + write subtitles (auto-generated or manual)
    const { stdout: infoJson } = await execFileAsync('yt-dlp', [
      '--dump-json',
      '--no-download',
      '--no-warnings',
      url,
    ], { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });

    const info = JSON.parse(infoJson);
    const title = info.title || 'Unknown';
    const duration = info.duration || 0;

    // Check if subtitles exist
    const hasSubs = info.subtitles && Object.keys(info.subtitles).length > 0;
    const hasAutoSubs = info.automatic_captions && Object.keys(info.automatic_captions).length > 0;

    if (!hasSubs && !hasAutoSubs) {
      logger.info('No subtitles available for YouTube video', { url, title });
      return null;
    }

    // Download subtitles only (prefer English, fall back to auto-generated)
    await execFileAsync('yt-dlp', [
      '--write-sub',
      '--write-auto-sub',
      '--sub-lang', 'en,es',
      '--sub-format', 'vtt',
      '--skip-download',
      '--no-warnings',
      '-o', basePath,
      url,
    ], { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });

    // Find the subtitle file
    const base = path.basename(basePath);
    const subFiles = fs.readdirSync(TEMP_DIR)
      .filter(f => f.startsWith(base) && (f.endsWith('.vtt') || f.endsWith('.srt')))
      .map(f => path.join(TEMP_DIR, f));

    if (subFiles.length === 0) {
      logger.info('Subtitle download produced no files', { url });
      return null;
    }

    // Parse VTT/SRT: strip timestamps and metadata, keep text
    const raw = fs.readFileSync(subFiles[0], 'utf-8');
    const text = parseSubtitles(raw);

    // Clean up subtitle files
    subFiles.forEach(safeDelete);

    if (text.length < 50) {
      logger.info('Subtitle text too short, falling back to audio', { url, len: text.length });
      return null;
    }

    logger.info('YouTube subtitles extracted', { title, duration, textLength: text.length });
    return { text, title, duration };
  } catch (err) {
    logger.debug('Subtitle extraction failed, will try audio', { url, error: err });
    // Clean up any partial files
    const base = path.basename(basePath);
    fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(base)).forEach(f => safeDelete(path.join(TEMP_DIR, f)));
    return null;
  }
}

/** Parse VTT/SRT subtitle format into plain text, removing duplicates from auto-captions */
function parseSubtitles(raw: string): string {
  const lines = raw.split('\n');
  const textLines: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines, timestamps, VTT headers, position tags
    if (!trimmed) continue;
    if (trimmed === 'WEBVTT') continue;
    if (trimmed.startsWith('Kind:') || trimmed.startsWith('Language:')) continue;
    if (trimmed.startsWith('NOTE')) continue;
    if (/^\d{2}:\d{2}/.test(trimmed)) continue; // timestamp line
    if (/^\d+$/.test(trimmed)) continue; // SRT sequence number

    // Strip HTML tags and VTT styling
    const clean = trimmed
      .replace(/<[^>]+>/g, '')
      .replace(/\{[^}]+\}/g, '')
      .trim();

    if (clean && !seen.has(clean)) {
      seen.add(clean);
      textLines.push(clean);
    }
  }

  return textLines.join(' ');
}

// ─── Audio Download + Transcribe (fallback) ─────────────────────

async function downloadAndTranscribe(url: string): Promise<{ transcript: string; title: string; duration: number }> {
  if (!(await isAvailable('yt-dlp'))) {
    throw new Error('yt-dlp is not installed on this server. Cannot process video.');
  }

  ensureTempDir();

  // Step 1: Get video info
  logger.info('Downloading audio for transcription', { url });

  const { stdout: infoJson } = await execFileAsync('yt-dlp', [
    '--dump-json', '--no-download', '--no-warnings', url,
  ], { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });

  const info = JSON.parse(infoJson);
  const title = info.title || 'Unknown';
  const duration = info.duration || 0;

  if (duration > MAX_AUDIO_DURATION) {
    throw new Error(`Video too long (${Math.round(duration / 60)} min). Max is ${MAX_AUDIO_DURATION / 60} min.`);
  }

  // Step 2: Download audio — use %(ext)s so yt-dlp manages the extension
  const basePath = tempPath('');

  await execFileAsync('yt-dlp', [
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', '5',
    '-o', `${basePath}.%(ext)s`,
    '--no-playlist',
    '--no-warnings',
    url,
  ], { timeout: 180_000, maxBuffer: 10 * 1024 * 1024 });

  // Step 3: Find the output file
  const base = path.basename(basePath);
  const candidates = fs.readdirSync(TEMP_DIR)
    .filter(f => f.startsWith(base) && !f.includes('_chunk'))
    .map(f => path.join(TEMP_DIR, f));

  if (candidates.length === 0) {
    throw new Error('yt-dlp completed but no audio file found');
  }

  const audioPath = candidates[0];
  const sizeMB = (fs.statSync(audioPath).size / 1024 / 1024).toFixed(1);
  logger.info('Audio downloaded', { title, duration, sizeMB, path: audioPath });

  // Step 4: Transcribe
  try {
    const transcript = await transcribeAudioFile(audioPath);
    return { transcript, title, duration };
  } finally {
    safeDelete(audioPath);
  }
}

// ─── Transcription ──────────────────────────────────────────────

async function transcribeAudioFile(filePath: string): Promise<string> {
  const openai = new OpenAI({ apiKey: getEnv().OPENAI_API_KEY });
  const stat = fs.statSync(filePath);

  // If small enough, transcribe directly
  if (stat.size <= WHISPER_MAX_SIZE) {
    return await whisperTranscribe(openai, filePath);
  }

  // Need to split — check for ffmpeg
  if (!(await isAvailable('ffmpeg'))) {
    throw new Error('Audio file too large and ffmpeg not available for splitting');
  }

  // Get duration
  let totalDuration: number;
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath,
    ], { timeout: 10_000 });
    totalDuration = parseFloat(stdout.trim());
  } catch {
    throw new Error('Cannot determine audio duration for splitting');
  }

  const numChunks = Math.ceil(stat.size / WHISPER_MAX_SIZE);
  const chunkSec = Math.ceil(totalDuration / numChunks);
  const transcripts: string[] = [];
  const chunkPaths: string[] = [];

  for (let i = 0; i < numChunks; i++) {
    const chunkPath = tempPath(`_chunk${i}.mp3`);
    chunkPaths.push(chunkPath);

    await execFileAsync('ffmpeg', [
      '-i', filePath, '-ss', String(i * chunkSec), '-t', String(chunkSec),
      '-acodec', 'libmp3lame', '-q:a', '5', '-y', chunkPath,
    ], { timeout: 60_000 });

    if (fs.existsSync(chunkPath) && fs.statSync(chunkPath).size > 1000) {
      try {
        const text = await whisperTranscribe(openai, chunkPath);
        transcripts.push(text);
      } catch (err) {
        logger.warn('Chunk transcription failed', { chunk: i, error: err });
      }
    }
  }

  // Clean up chunks
  chunkPaths.forEach(safeDelete);

  if (transcripts.length === 0) {
    throw new Error('All transcription chunks failed');
  }

  logger.info('Audio transcribed in chunks', { chunks: transcripts.length, totalChars: transcripts.join('').length });
  return transcripts.join('\n\n');
}

async function whisperTranscribe(openai: OpenAI, filePath: string): Promise<string> {
  const buffer = fs.readFileSync(filePath);
  const ext = path.extname(filePath).slice(1) || 'mp3';

  const result = await openai.audio.transcriptions.create({
    file: new File([buffer], `audio.${ext}`, { type: `audio/${ext}` }),
    model: 'whisper-1',
  });

  return result.text;
}

// ─── Telegram Video ─────────────────────────────────────────────

async function downloadTelegramAudio(fileId: string): Promise<string> {
  ensureTempDir();

  const bot = getTelegramBot();
  if (!bot) throw new Error('Telegram bot not configured');

  const file = await bot.api.getFile(fileId);
  if (!file.file_path) throw new Error('Telegram file path not available');

  // Telegram Bot API: max 20MB download
  const token = getEnv().TELEGRAM_BOT_TOKEN;
  const resp = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!resp.ok) throw new Error(`Telegram download failed: ${resp.status}`);

  const buffer = Buffer.from(await resp.arrayBuffer());
  const ext = path.extname(file.file_path) || '.mp4';
  const videoPath = tempPath(ext);
  fs.writeFileSync(videoPath, buffer);

  // If already audio, return as-is
  if (['.mp3', '.ogg', '.wav', '.m4a', '.aac', '.opus'].includes(ext.toLowerCase())) {
    return videoPath;
  }

  // Extract audio with ffmpeg
  if (!(await isAvailable('ffmpeg'))) {
    return videoPath; // Whisper can handle some video formats
  }

  const mp3Path = tempPath('.mp3');
  try {
    await execFileAsync('ffmpeg', [
      '-i', videoPath, '-vn', '-acodec', 'libmp3lame', '-q:a', '5', '-y', mp3Path,
    ], { timeout: 120_000 });
    safeDelete(videoPath);
    return mp3Path;
  } catch {
    safeDelete(mp3Path);
    return videoPath; // Fall back to original
  }
}

// ─── Public API ─────────────────────────────────────────────────

export interface VideoSummaryResult {
  title: string;
  platform: string;
  duration: number;
  transcript: string;
  url: string;
  method: 'subtitles' | 'whisper';
}

/** Process a YouTube or Instagram video URL → transcript */
export async function processVideoUrl(url: string): Promise<VideoSummaryResult> {
  const video = detectVideoUrl(url);
  if (!video) throw new Error('Not a recognized video URL');

  // YouTube: try subtitles first (fast, free, no audio download)
  if (video.platform === 'youtube') {
    const subs = await getYouTubeSubtitles(video.url);
    if (subs) {
      return {
        title: subs.title,
        platform: 'youtube',
        duration: subs.duration,
        transcript: subs.text,
        url: video.url,
        method: 'subtitles',
      };
    }
  }

  // Fallback: download audio → Whisper transcription
  const result = await downloadAndTranscribe(video.url);
  return {
    title: result.title,
    platform: video.platform,
    duration: result.duration,
    transcript: result.transcript,
    url: video.url,
    method: 'whisper',
  };
}

/** Process a Telegram-forwarded video → transcript */
export async function processTelegramVideo(fileId: string): Promise<VideoSummaryResult> {
  const audioPath = await downloadTelegramAudio(fileId);

  try {
    const transcript = await transcribeAudioFile(audioPath);
    return {
      title: 'Telegram Video',
      platform: 'telegram',
      duration: 0,
      transcript,
      url: '',
      method: 'whisper',
    };
  } finally {
    safeDelete(audioPath);
  }
}

/** Clean up old temp files */
export function cleanupTempFiles(maxAgeMs: number = 3600_000): void {
  if (!fs.existsSync(TEMP_DIR)) return;
  const now = Date.now();
  for (const file of fs.readdirSync(TEMP_DIR)) {
    try {
      const full = path.join(TEMP_DIR, file);
      if (now - fs.statSync(full).mtimeMs > maxAgeMs) fs.unlinkSync(full);
    } catch {}
  }
}
