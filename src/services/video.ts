import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import OpenAI from 'openai';
import { getEnv } from '../config/env.js';
import { getTelegramBot } from './telegram.js';
import logger from '../utils/logger.js';

const execFileAsync = promisify(execFile);

const TEMP_DIR = '/tmp/atlas-video';
const WHISPER_MAX_SIZE = 24 * 1024 * 1024; // 24MB safety margin from 25MB limit
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

// ─── Helpers ────────────────────────────────────────────────────

function ensureTempDir() {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function tempPath(suffix: string): string {
  return path.join(TEMP_DIR, `${crypto.randomBytes(8).toString('hex')}${suffix}`);
}

/** Check if a CLI tool is available */
async function isToolAvailable(cmd: string): Promise<boolean> {
  try {
    await execFileAsync('which', [cmd], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// ─── Audio Download ─────────────────────────────────────────────

/** Download audio from a YouTube or Instagram URL via yt-dlp */
export async function downloadAudio(url: string): Promise<{ filePath: string; title: string; duration: number }> {
  ensureTempDir();

  // Verify yt-dlp is available
  if (!(await isToolAvailable('yt-dlp'))) {
    throw new Error('yt-dlp is not installed on this server');
  }

  logger.info('Downloading audio via yt-dlp', { url });

  try {
    // Get video info first
    const { stdout: infoJson } = await execFileAsync('yt-dlp', [
      '--dump-json', '--no-download', '--no-warnings', url,
    ], { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });

    const info = JSON.parse(infoJson);
    const title = info.title || 'Unknown';
    const duration = info.duration || 0;

    if (duration > MAX_AUDIO_DURATION) {
      throw new Error(`Video too long (${Math.round(duration / 60)} min). Max ${MAX_AUDIO_DURATION / 60} min.`);
    }

    // Use a base path WITHOUT extension — yt-dlp adds its own
    const basePath = tempPath('');
    const expectedMp3 = basePath + '.mp3';

    // Download audio only, extract to mp3
    await execFileAsync('yt-dlp', [
      '-x',                         // extract audio
      '--audio-format', 'mp3',      // convert to mp3
      '--audio-quality', '5',       // medium quality (smaller files)
      '-o', basePath + '.%(ext)s',  // let yt-dlp manage extension
      '--no-playlist',              // single video only
      '--no-warnings',
      url,
    ], { timeout: 180_000, maxBuffer: 10 * 1024 * 1024 });

    // Find the output file — yt-dlp creates <base>.mp3
    let actualPath: string | null = null;
    if (fs.existsSync(expectedMp3)) {
      actualPath = expectedMp3;
    } else {
      // Scan temp dir for files matching our base
      const base = path.basename(basePath);
      const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(base));
      if (files.length > 0) {
        actualPath = path.join(TEMP_DIR, files[0]);
      }
    }

    if (!actualPath || !fs.existsSync(actualPath)) {
      throw new Error('yt-dlp completed but audio file not found');
    }

    const sizeMB = (fs.statSync(actualPath).size / 1024 / 1024).toFixed(1);
    logger.info('Audio downloaded', { title, duration, sizeMB });

    return { filePath: actualPath, title, duration };
  } catch (err: any) {
    // Provide more helpful error messages
    const msg = err.message || String(err);
    if (msg.includes('is not a valid URL') || msg.includes('Unsupported URL')) {
      throw new Error(`URL not supported by yt-dlp: ${url}`);
    }
    if (msg.includes('Private video') || msg.includes('Sign in')) {
      throw new Error('This video is private or requires login');
    }
    if (msg.includes('Video unavailable')) {
      throw new Error('Video is unavailable or has been removed');
    }
    throw new Error(`Failed to download audio: ${msg}`);
  }
}

/** Download audio from a Telegram video file */
export async function downloadTelegramVideo(fileId: string): Promise<{ filePath: string }> {
  ensureTempDir();

  const bot = getTelegramBot();
  if (!bot) throw new Error('Telegram bot not configured');

  const file = await bot.api.getFile(fileId);
  const filePath = file.file_path;
  if (!filePath) throw new Error('Telegram file path not available');

  const token = getEnv().TELEGRAM_BOT_TOKEN;
  const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const response = await fetch(fileUrl);
  if (!response.ok) throw new Error(`Failed to download from Telegram: ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  const ext = path.extname(filePath) || '.mp4';
  const localPath = tempPath(ext);
  fs.writeFileSync(localPath, buffer);

  logger.info('Telegram video downloaded', { fileId, sizeMB: (buffer.length / 1024 / 1024).toFixed(1) });

  // If it's already an audio format, return as-is
  const audioExts = ['.mp3', '.ogg', '.wav', '.m4a', '.aac'];
  if (audioExts.includes(ext.toLowerCase())) {
    return { filePath: localPath };
  }

  // Convert to mp3 using ffmpeg
  if (!(await isToolAvailable('ffmpeg'))) {
    // If no ffmpeg, try to transcribe the video file directly (Whisper accepts some video formats)
    return { filePath: localPath };
  }

  const mp3Path = tempPath('.mp3');
  try {
    await execFileAsync('ffmpeg', [
      '-i', localPath,
      '-vn',                       // no video
      '-acodec', 'libmp3lame',
      '-q:a', '5',                 // medium quality
      '-y',                        // overwrite
      mp3Path,
    ], { timeout: 120_000 });

    // Clean up original video file
    try { fs.unlinkSync(localPath); } catch {}
    return { filePath: mp3Path };
  } catch (err) {
    // If ffmpeg fails, try the original file
    logger.warn('ffmpeg conversion failed, trying original file', { error: err });
    try { fs.unlinkSync(mp3Path); } catch {}
    return { filePath: localPath };
  }
}

// ─── Transcription ──────────────────────────────────────────────

/** Split audio into chunks if over Whisper's 25MB limit */
async function splitAudioIfNeeded(filePath: string): Promise<string[]> {
  const stat = fs.statSync(filePath);

  if (stat.size <= WHISPER_MAX_SIZE) {
    return [filePath];
  }

  if (!(await isToolAvailable('ffprobe')) || !(await isToolAvailable('ffmpeg'))) {
    logger.warn('ffmpeg/ffprobe not available for splitting — sending full file');
    return [filePath];
  }

  const totalSize = stat.size;
  const numChunks = Math.ceil(totalSize / WHISPER_MAX_SIZE);

  // Get duration via ffprobe
  let totalDuration: number;
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'csv=p=0', filePath,
    ], { timeout: 10_000 });
    totalDuration = parseFloat(stdout.trim());
  } catch {
    // Can't determine duration — return original
    logger.warn('Cannot determine audio duration, sending full file');
    return [filePath];
  }

  const chunkDuration = Math.ceil(totalDuration / numChunks);
  const chunks: string[] = [];

  for (let i = 0; i < numChunks; i++) {
    const chunkPath = tempPath(`_chunk${i}.mp3`);
    const startTime = i * chunkDuration;

    try {
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
    } catch (err) {
      logger.warn('Failed to create audio chunk', { chunk: i, error: err });
    }
  }

  if (chunks.length === 0) {
    logger.warn('All chunks failed, returning original file');
    return [filePath];
  }

  logger.info('Audio split into chunks', { original: filePath, chunks: chunks.length, totalDuration });
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

    try {
      const transcription = await openai.audio.transcriptions.create({
        file: new File([buffer], `audio.${ext}`, { type: `audio/${ext}` }),
        model: 'whisper-1',
      });

      transcripts.push(transcription.text);
      logger.debug('Chunk transcribed', { chunk: chunkPath, length: transcription.text.length });
    } catch (err) {
      logger.error('Whisper transcription failed for chunk', { chunk: chunkPath, error: err });
      // Continue with other chunks
    }
  }

  // Clean up chunk files (but not the original if it wasn't split)
  for (const chunkPath of chunks) {
    if (chunkPath !== filePath) {
      try { fs.unlinkSync(chunkPath); } catch {}
    }
  }

  if (transcripts.length === 0) {
    throw new Error('Transcription failed — no audio content could be extracted');
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
