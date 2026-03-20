import { Hono } from 'hono';
import twilio from 'twilio';
import {
  getOrCreateCall,
  processVoiceInput,
  getGreeting,
  getOutboundGreeting,
  getCallMeta,
  endCall,
  isGoodbye,
} from '../services/voice-call.js';
import logger from '../utils/logger.js';

const VoiceResponse = twilio.twiml.VoiceResponse;
const voiceRouter = new Hono();

// Atlas voice configuration
const ATLAS_VOICE = 'Polly.Matthew-Neural' as const;
const LANGUAGE = 'en-US';

/** Build a <Gather> element for speech input */
function addGather(response: InstanceType<typeof VoiceResponse>, actionPath: string = '/voice/respond') {
  return response.gather({
    input: ['speech'],
    action: actionPath,
    method: 'POST',
    language: LANGUAGE,
    speechTimeout: 'auto',
    speechModel: 'phone_call',
  });
}

// ─── Incoming Call ──────────────────────────────────────────────

voiceRouter.post('/incoming', async (c) => {
  const body = await c.req.parseBody();
  const callSid = body['CallSid'] as string;
  const callerNumber = body['From'] as string;

  logger.info('Incoming voice call', { callSid, from: callerNumber });

  const state = getOrCreateCall(callSid, callerNumber);
  const greeting = getGreeting(state);

  const twiml = new VoiceResponse();
  const gather = addGather(twiml);
  gather.say({ voice: ATLAS_VOICE, language: LANGUAGE }, greeting);

  // Fallback if caller doesn't speak
  twiml.say({ voice: ATLAS_VOICE, language: LANGUAGE }, 'Are you still there? Say something and I\'ll help you out.');
  twiml.redirect({ method: 'POST' }, '/voice/incoming');

  return c.text(twiml.toString(), 200, { 'Content-Type': 'text/xml' });
});

// ─── Speech Response ────────────────────────────────────────────

voiceRouter.post('/respond', async (c) => {
  const body = await c.req.parseBody();
  const callSid = body['CallSid'] as string;
  const speechResult = body['SpeechResult'] as string;
  const confidence = body['Confidence'] as string;

  logger.info('Voice speech received', {
    callSid,
    speech: speechResult?.slice(0, 120),
    confidence,
  });

  const twiml = new VoiceResponse();

  // No speech detected
  if (!speechResult?.trim()) {
    const gather = addGather(twiml);
    gather.say(
      { voice: ATLAS_VOICE, language: LANGUAGE },
      "Sorry, I didn't catch that. Could you say that again?",
    );
    twiml.say({ voice: ATLAS_VOICE, language: LANGUAGE }, 'If you\'re done, feel free to hang up. Goodbye!');
    return c.text(twiml.toString(), 200, { 'Content-Type': 'text/xml' });
  }

  // Goodbye detection
  if (isGoodbye(speechResult)) {
    twiml.say({ voice: ATLAS_VOICE, language: LANGUAGE }, 'Take care! Goodbye.');
    twiml.hangup();
    endCall(callSid).catch(() => {});
    return c.text(twiml.toString(), 200, { 'Content-Type': 'text/xml' });
  }

  // Process through Claude AI (shared brain with Telegram/WhatsApp)
  const callerNumber = body['From'] as string;
  const aiResponse = await processVoiceInput(callSid, callerNumber, speechResult);

  // Speak the response and listen for more
  const gather = addGather(twiml);
  gather.say({ voice: ATLAS_VOICE, language: LANGUAGE }, aiResponse);

  // Fallback if caller stops talking
  twiml.say({ voice: ATLAS_VOICE, language: LANGUAGE }, 'Anything else I can help with?');
  twiml.redirect({ method: 'POST' }, '/voice/incoming');

  return c.text(twiml.toString(), 200, { 'Content-Type': 'text/xml' });
});

// ─── Outbound Call (when recipient picks up) ────────────────────

voiceRouter.post('/outbound', async (c) => {
  const body = await c.req.parseBody();
  const callSid = body['CallSid'] as string;
  const calledNumber = body['To'] as string;

  // Read purpose from query param (set by initiateOutboundCall)
  const purpose = decodeURIComponent(c.req.query('purpose') || 'follow up on a matter');

  logger.info('Outbound call answered', { callSid, to: calledNumber, purpose: purpose.slice(0, 100) });

  // Ensure call metadata exists (should have been pre-registered)
  const meta = getCallMeta(callSid);
  if (!meta) {
    getOrCreateCall(callSid, calledNumber);
  }

  const greeting = getOutboundGreeting(purpose);

  const twiml = new VoiceResponse();
  const gather = addGather(twiml);
  gather.say({ voice: ATLAS_VOICE, language: LANGUAGE }, greeting);

  // Fallback if they don't speak
  twiml.say({ voice: ATLAS_VOICE, language: LANGUAGE }, 'Are you still there?');
  twiml.redirect({ method: 'POST' }, '/voice/incoming');

  return c.text(twiml.toString(), 200, { 'Content-Type': 'text/xml' });
});

// ─── Call Status Callback ───────────────────────────────────────

voiceRouter.post('/status', async (c) => {
  const body = await c.req.parseBody();
  const callSid = body['CallSid'] as string;
  const callStatus = body['CallStatus'] as string;

  logger.info('Voice call status', { callSid, status: callStatus });

  const terminalStatuses = ['completed', 'busy', 'no-answer', 'canceled', 'failed'];
  if (terminalStatuses.includes(callStatus)) {
    await endCall(callSid);
  }

  return c.text('', 200);
});

export default voiceRouter;
