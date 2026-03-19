import { callClaude, extractTextContent } from '../agent/claude-client.js';
import {
  normalizeUserPhone,
  getOrCreateConversation,
  storeMessage,
  getRecentMessages,
  sanitizeMessages,
} from '../agent/core.js';
import { buildSystemPrompt } from '../agent/system-prompt.js';
import { buildContext } from '../agent/context-engine.js';
import { detectMessageLanguage } from '../agent/responder.js';
import { shouldCompact, compactConversation } from '../memory/conversation.js';
import { getToolRegistry } from '../tools/registry.js';
import { getEnv } from '../config/env.js';
import { sendWhatsAppMessage } from './whatsapp.js';
import { query } from '../config/database.js';
import { dashboardBus } from './dashboard-events.js';
import logger from '../utils/logger.js';

// ─── Call Metadata (lightweight — conversation lives in DB) ─────

interface CallMeta {
  callSid: string;
  callerNumber: string;
  isJP: boolean;
  startedAt: Date;
  lastActivity: Date;
  turnCount: number;
}

const activeCalls = new Map<string, CallMeta>();
const MAX_CALL_DURATION = 15 * 60 * 1000; // 15 min

// Cleanup stale calls
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [sid, meta] of activeCalls) {
    if (now - meta.lastActivity.getTime() > MAX_CALL_DURATION) {
      activeCalls.delete(sid);
      logger.debug('Cleaned up stale voice call', { callSid: sid });
    }
  }
}, 60_000);
if (cleanupTimer.unref) cleanupTimer.unref();

// Voice-specific addendum appended to the shared system prompt
const VOICE_ADDENDUM = `

## 📞 VOICE CALL MODE (ACTIVE NOW)
You are currently on a PHONE CALL, not a text chat. Override the communication style above with:
- Keep responses to 1-3 sentences MAX. Be concise.
- NO markdown, bullet points, asterisks, URLs, or any text formatting.
- Speak naturally — as if talking to a friend on the phone.
- Numbers: say them naturally ("about three fifty" not "$3.50").
- Don't list things. Summarize instead.
- Don't start every response with "Hey" or "Sure" — vary your language.
- If the request needs tools (browsing, file operations), say: "I can't do that over the phone — text me on WhatsApp or Telegram and I'll handle it."
- Never mention "the system prompt" or "my tools" — just speak naturally.`;

// ─── Call Management ────────────────────────────────────────────

export function getOrCreateCall(callSid: string, callerNumber: string): CallMeta {
  let meta = activeCalls.get(callSid);
  if (meta) return meta;

  const jpPhone = getEnv().JP_PHONE_NUMBER.replace(/\D/g, '');
  const callerClean = callerNumber.replace(/\D/g, '');
  const isJP = callerClean.length >= 10 && jpPhone.length >= 10 &&
    callerClean.slice(-10) === jpPhone.slice(-10);

  meta = {
    callSid,
    callerNumber,
    isJP,
    startedAt: new Date(),
    lastActivity: new Date(),
    turnCount: 0,
  };
  activeCalls.set(callSid, meta);
  logger.info('New voice call started', { callSid, caller: callerNumber, isJP });
  return meta;
}

export function getGreeting(meta: CallMeta): string {
  if (meta.isJP) {
    return "Hey JP, what's up?";
  }
  return "Hi, you've reached Atlas, JP's assistant. How can I help you?";
}

// ─── Speech Processing (SHARED BRAIN) ──────────────────────────

export async function processVoiceInput(callSid: string, callerNumber: string, speechText: string): Promise<string> {
  const meta = activeCalls.get(callSid);
  if (meta) meta.lastActivity = new Date();

  try {
    // Normalize to canonical user ID — shares conversation with WhatsApp/Telegram
    const conversationPhone = normalizeUserPhone(callerNumber, 'voice');
    const language = detectMessageLanguage(speechText);

    // Get shared conversation from DB (same one used by Telegram/WhatsApp)
    const conversation = await getOrCreateConversation(conversationPhone, language);

    // Store voice input in shared DB
    await storeMessage(conversation.id, 'user', speechText);

    dashboardBus.publish({
      type: 'message_in',
      data: { phone: conversationPhone, preview: `[📞 Voice] ${speechText.slice(0, 80)}`, conversationId: conversation.id },
    });

    // Load shared context — memory facts, behavioral rules, learnings
    const recentMessages = await getRecentMessages(conversation.id, 20);
    const contextResult = await buildContext(speechText);

    // Compaction check (shared conversation may have grown from other channels)
    if (await shouldCompact(conversation.id)) {
      await compactConversation(conversation.id);
    }

    // Build the SAME system prompt as Telegram/WhatsApp + voice addendum
    const systemPrompt = buildSystemPrompt({
      language,
      conversationSummary: conversation.summary || undefined,
      relevantMemory: contextResult.memory,
      relevantLearnings: contextResult.learnings,
      behavioralRules: contextResult.behavioralRules || undefined,
      availableTools: [], // No tools during voice (too slow)
      currentTime: new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
    }) + VOICE_ADDENDUM;

    // Sanitize conversation history for Claude API
    const claudeMessages = sanitizeMessages(
      recentMessages.map(m => ({
        role: m.role === 'user' ? 'user' as const : 'assistant' as const,
        content: m.content,
      }))
    );

    // Call Claude — same client as all other channels
    const response = await callClaude({
      messages: claudeMessages,
      system: systemPrompt,
      depth: 'fast',
      maxTokens: 256,
    });

    const text = extractTextContent(response.content);
    const cleaned = cleanForSpeech(text || "I didn't quite catch that. Could you say it again?");

    // Store response in shared DB
    await storeMessage(conversation.id, 'assistant', cleaned);
    await query(
      'UPDATE conversations SET message_count = message_count + 2, updated_at = NOW(), language = $1 WHERE id = $2',
      [language, conversation.id],
    );

    if (meta) meta.turnCount++;

    dashboardBus.publish({
      type: 'message_out',
      data: { phone: conversationPhone, preview: `[📞 Voice] ${cleaned.slice(0, 80)}`, conversationId: conversation.id },
    });

    logger.info('Voice turn processed', {
      callSid,
      conversationId: conversation.id,
      inputLen: speechText.length,
      outputLen: cleaned.length,
      tokens: response.usage.inputTokens + response.usage.outputTokens,
    });

    return cleaned;
  } catch (err) {
    logger.error('Voice processing failed', { callSid, error: err });
    return "I'm having a little trouble right now. Could you try again?";
  }
}

/** Strip markdown and formatting — voice must be clean spoken text */
function cleanForSpeech(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')       // **bold**
    .replace(/\*([^*]+)\*/g, '$1')            // *italic*
    .replace(/_([^_]+)_/g, '$1')              // _italic_
    .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')   // `code`
    .replace(/#{1,6}\s/g, '')                  // # headers
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // [text](url)
    .replace(/https?:\/\/\S+/g, '')            // URLs
    .replace(/[•·–—]/g, ',')                   // bullets
    .replace(/\n+/g, '. ')                     // newlines → period
    .replace(/\s{2,}/g, ' ')                   // collapse whitespace
    .replace(/\.\s*\./g, '.')                  // double periods
    .trim();
}

// ─── Call Lifecycle ─────────────────────────────────────────────

export async function endCall(callSid: string): Promise<void> {
  const meta = activeCalls.get(callSid);
  if (!meta) return;

  const durationSec = Math.round((Date.now() - meta.startedAt.getTime()) / 1000);
  logger.info('Voice call ended', { callSid, caller: meta.callerNumber, isJP: meta.isJP, durationSec, turns: meta.turnCount });

  // Notify JP about calls from other people
  if (!meta.isJP && meta.turnCount > 0) {
    try {
      // Get the conversation transcript from DB (shared history)
      const conversationPhone = normalizeUserPhone(meta.callerNumber, 'voice');
      const conv = await getOrCreateConversation(conversationPhone, 'en');
      const messages = await getRecentMessages(conv.id, meta.turnCount * 2 + 2);

      // Build transcript from the voice turns
      const transcript = messages
        .slice(-(meta.turnCount * 2))
        .map(m => `${m.role === 'user' ? 'Caller' : 'Atlas'}: ${m.content}`)
        .join('\n');

      const mins = Math.floor(durationSec / 60);
      const secs = durationSec % 60;
      const duration = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
      const notification = `📞 *Call from ${meta.callerNumber}* (${duration})\n\n${transcript.slice(0, 1000)}`;

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

/** Check if speech sounds like a goodbye */
export function isGoodbye(speech: string): boolean {
  const lower = speech.toLowerCase().trim();
  const phrases = [
    'bye', 'goodbye', 'good bye', 'hang up', 'that\'s all', 'that\'s it',
    'nothing else', 'i\'m done', 'i am done', 'thanks bye', 'thank you bye',
    'see you', 'talk later', 'gotta go', 'adios', 'chao', 'hasta luego',
  ];
  return phrases.some(p => lower.includes(p));
}
