import { callClaude, extractTextContent } from '../agent/claude-client.js';
import { getEnv } from '../config/env.js';
import { sendWhatsAppMessage } from './whatsapp.js';
import logger from '../utils/logger.js';
import type Anthropic from '@anthropic-ai/sdk';

// ─── Types ──────────────────────────────────────────────────────

interface CallState {
  callSid: string;
  callerNumber: string;
  isJP: boolean;
  messages: Anthropic.MessageParam[];
  startedAt: Date;
  lastActivity: Date;
}

// ─── State ──────────────────────────────────────────────────────

const activeCalls = new Map<string, CallState>();
const MAX_CALL_DURATION = 15 * 60 * 1000; // 15 minutes
const MAX_HISTORY = 20; // conversation turns to keep

// Clean up stale calls every minute
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [sid, state] of activeCalls) {
    if (now - state.lastActivity.getTime() > MAX_CALL_DURATION) {
      activeCalls.delete(sid);
      logger.debug('Cleaned up stale voice call', { callSid: sid });
    }
  }
}, 60_000);
if (cleanupTimer.unref) cleanupTimer.unref();

// ─── System Prompts ─────────────────────────────────────────────

function getSystemPrompt(isJP: boolean): string {
  const date = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  if (isJP) {
    return `You are Atlas, JP's personal AI assistant, on a phone call with JP.
Today is ${date}.

Rules for phone conversation:
- Keep responses to 1-3 sentences. This is a voice call, not a chat.
- No markdown, bullet points, URLs, or text formatting — speak naturally.
- Be warm, casual, and efficient — like a smart friend.
- Vary your openings. Don't start every response the same way.
- If he asks something requiring tools (browsing, files, searches), suggest texting on WhatsApp or Telegram.
- Numbers: say them naturally ("about three fifty" not "3.50").
- Avoid lists. Summarize instead.`;
  }

  return `You are Atlas, JP's AI assistant, answering the phone on his behalf.
Today is ${date}.

Rules for phone conversation:
- Professional and friendly. 1-2 sentences max.
- No markdown or formatting — natural speech only.
- Take messages for JP. Ask for the caller's name if they haven't given it.
- Never share JP's personal info, schedule, or contact details.
- For urgent matters, say you'll pass the message along right away.
- If unsure, offer to take a message.`;
}

// ─── Call Management ────────────────────────────────────────────

export function getOrCreateCall(callSid: string, callerNumber: string): CallState {
  let state = activeCalls.get(callSid);
  if (state) return state;

  // Check if caller is JP by comparing last 10 digits
  const jpPhone = getEnv().JP_PHONE_NUMBER.replace(/\D/g, '');
  const callerClean = callerNumber.replace(/\D/g, '');
  const isJP = callerClean.length >= 10 && jpPhone.length >= 10 &&
    (callerClean.slice(-10) === jpPhone.slice(-10));

  state = {
    callSid,
    callerNumber,
    isJP,
    messages: [],
    startedAt: new Date(),
    lastActivity: new Date(),
  };
  activeCalls.set(callSid, state);
  logger.info('New voice call started', { callSid, caller: callerNumber, isJP });
  return state;
}

export function getGreeting(state: CallState): string {
  if (state.isJP) {
    return "Hey JP, what's up?";
  }
  return "Hi, you've reached Atlas, JP's assistant. How can I help you?";
}

// ─── Speech Processing ─────────────────────────────────────────

export async function processVoiceInput(callSid: string, speechText: string): Promise<string> {
  const state = activeCalls.get(callSid);
  if (!state) {
    return "Sorry, I lost track of our conversation. Could you call back?";
  }

  state.lastActivity = new Date();
  state.messages.push({ role: 'user', content: speechText });

  // Keep conversation history bounded
  if (state.messages.length > MAX_HISTORY) {
    state.messages = state.messages.slice(-MAX_HISTORY);
  }

  try {
    const response = await callClaude({
      messages: state.messages,
      system: getSystemPrompt(state.isJP),
      depth: 'fast',
      maxTokens: 256, // Short for voice
    });

    const text = extractTextContent(response.content);
    const cleaned = cleanForSpeech(text || "I didn't quite catch that. Could you say it again?");

    state.messages.push({ role: 'assistant', content: cleaned });
    return cleaned;
  } catch (err) {
    logger.error('Voice Claude call failed', { callSid, error: err });
    return "I'm having a little trouble right now. Could you try again?";
  }
}

/** Strip markdown and formatting artifacts that slip through — voice must be plain text */
function cleanForSpeech(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')       // **bold** → text
    .replace(/\*([^*]+)\*/g, '$1')            // *italic* → text
    .replace(/_([^_]+)_/g, '$1')              // _italic_ → text
    .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')   // `code` → text
    .replace(/#{1,6}\s/g, '')                  // # headers → text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // [text](url) → text
    .replace(/https?:\/\/\S+/g, '')            // Remove URLs
    .replace(/[•·–—]/g, ',')                   // Bullets/dashes → comma
    .replace(/\n+/g, '. ')                     // Newlines → period
    .replace(/\s{2,}/g, ' ')                   // Collapse whitespace
    .replace(/\.\s*\./g, '.')                  // Remove double periods
    .trim();
}

// ─── Call Lifecycle ─────────────────────────────────────────────

export async function endCall(callSid: string): Promise<void> {
  const state = activeCalls.get(callSid);
  if (!state) return;

  const durationSec = Math.round((Date.now() - state.startedAt.getTime()) / 1000);
  logger.info('Voice call ended', { callSid, caller: state.callerNumber, isJP: state.isJP, durationSec });

  // Notify JP about calls from other people
  if (!state.isJP && state.messages.length > 0) {
    try {
      const transcript = state.messages
        .map(m => {
          const label = m.role === 'user' ? 'Caller' : 'Atlas';
          const text = typeof m.content === 'string' ? m.content : '';
          return `${label}: ${text}`;
        })
        .join('\n');

      const mins = Math.floor(durationSec / 60);
      const secs = durationSec % 60;
      const duration = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
      const notification = `📞 *Call from ${state.callerNumber}* (${duration})\n\n${transcript.slice(0, 1000)}`;

      await sendWhatsAppMessage(getEnv().JP_PHONE_NUMBER, notification);
      logger.info('Notified JP about voice call', { callSid });
    } catch (err) {
      logger.debug('Failed to notify JP about call', { error: err });
    }
  }

  activeCalls.delete(callSid);
}

export function getActiveCallCount(): number {
  return activeCalls.size;
}

/** Check if a speech input sounds like a goodbye */
export function isGoodbye(speech: string): boolean {
  const lower = speech.toLowerCase().trim();
  const phrases = [
    'bye', 'goodbye', 'good bye', 'hang up', 'that\'s all', 'that\'s it',
    'nothing else', 'i\'m done', 'i am done', 'thanks bye', 'thank you bye',
    'see you', 'talk later', 'gotta go', 'adios', 'chao', 'hasta luego',
  ];
  return phrases.some(p => lower.includes(p));
}
