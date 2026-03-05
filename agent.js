import dotenv from 'dotenv';
dotenv.config();

// LiveKit Agents framework and plugins
import {
  cli,
  defineAgent,
  inference,
  metrics,
  voice,
  ServerOptions,
} from '@livekit/agents';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as silero from '@livekit/agents-plugin-silero';
import { TelephonyBackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';

// HTTP server + Twilio webhook validation
import express from 'express';
import bodyParser from 'body-parser';
import twilio from 'twilio';

// Airtable logging
import fetch from 'node-fetch';

// Node utilities
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// LiveKit Server SDK for SIP outbound (create room + dial out)
import { SipClient, AgentDispatchClient } from 'livekit-server-sdk';

// ------------------------------
// Configuration helpers
// ------------------------------

function envRequired(name) {
  const value = process.env[name];
  if (!value) {
    console.warn(`[config] Missing required env variable: ${name}`);
  }
  return value;
}

const LIVEKIT_URL = envRequired('LIVEKIT_URL');
const LIVEKIT_API_KEY = envRequired('LIVEKIT_API_KEY');
const LIVEKIT_API_SECRET = envRequired('LIVEKIT_API_SECRET');
const LIVEKIT_AGENT_NAME = process.env.LIVEKIT_AGENT_NAME || 'inbound-voice-agent';

const AIRTABLE_PAT = envRequired('AIRTABLE_PAT');
const AIRTABLE_BASE_ID = envRequired('AIRTABLE_BASE_ID');
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || 'call_logs';

const MAX_CALL_DURATION_SECONDS = Number(process.env.MAX_CALL_DURATION_SECONDS || '900'); // default 15min

const PUBLIC_BASE_URL = envRequired('PUBLIC_BASE_URL');
// On platforms like Render, the HTTP service port is provided via PORT.
// Fall back to TWILIO_WEBHOOK_PORT (for local dev) and then 3000.
const TWILIO_WEBHOOK_PORT = Number(process.env.PORT || process.env.TWILIO_WEBHOOK_PORT || '3000');
const TWILIO_AUTH_TOKEN = envRequired('TWILIO_AUTH_TOKEN');
const LIVEKIT_SIP_URI = envRequired('LIVEKIT_SIP_URI');

// Optional: for outbound test calls (server triggers Twilio to call a number)
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

// LiveKit API base URL (SipClient/AgentDispatch need https, not wss)
function getLiveKitApiUrl() {
  const url = (LIVEKIT_URL || '').trim();
  if (url.startsWith('wss://')) return url.replace(/^wss:\/\//, 'https://');
  if (url.startsWith('ws://')) return url.replace(/^ws:\/\//, 'http://');
  return url;
}

// Default SIP outbound config from sip-participant.json (optional)
let sipParticipantDefaults = {};
try {
  const path = join(dirname(fileURLToPath(import.meta.url)), 'sip-participant.json');
  sipParticipantDefaults = JSON.parse(readFileSync(path, 'utf8'));
} catch {
  // File missing or invalid; use env only
}
const SIP_OUTBOUND_TRUNK_ID = process.env.SIP_OUTBOUND_TRUNK_ID || sipParticipantDefaults.sip_trunk_id;

// ------------------------------
// Simple Agent definition
// ------------------------------

class InboundVoiceAgent extends voice.Agent {
  constructor() {
    super({
      instructions: `
You are a friendly, concise voice assistant answering inbound phone calls for this business.
The caller is speaking by phone, often in noisy environments, so keep your sentences short and clear.
Ask clarifying questions when needed and avoid technical jargon.
Never mention that you are running on LiveKit or using external APIs.
`.trim(),
    });
  }
}

// ------------------------------
// Airtable logging
// ------------------------------

/**
 * Insert a single call log row into Airtable.
 * Errors are caught and logged so they never affect the call flow.
 */
async function logCallToAirtable({ callerNumber, durationSeconds, transcript, createdAt }) {
  if (!AIRTABLE_PAT || !AIRTABLE_BASE_ID) {
    console.warn('[airtable] Skipping logging because AIRTABLE_PAT or AIRTABLE_BASE_ID is not set.');
    return;
  }

  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(
    AIRTABLE_TABLE_NAME,
  )}`;

  const body = {
    records: [
      {
        fields: {
          caller_number: callerNumber || 'unknown',
          duration_seconds: durationSeconds,
          transcript: transcript || '',
          created_at: createdAt || new Date().toISOString(),
        },
      },
    ],
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${AIRTABLE_PAT}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('[airtable] Failed to log call', res.status, text);
    } else {
      console.log('[airtable] Call logged successfully.');
    }
  } catch (err) {
    console.error('[airtable] Error logging call:', err);
  }
}

/**
 * Build a human-readable transcript string from the AgentSession ChatContext.
 * If the structure is unexpected, we fall back to JSON.
 */
function buildTranscriptFromChatContext(chatCtx) {
  try {
    const json = chatCtx.toJSON({ excludeAudio: true, excludeImage: true, excludeTimestamp: false });
    const items = Array.isArray(json.items) ? json.items : Array.isArray(json) ? json : [];

    if (!Array.isArray(items) || items.length === 0) {
      return JSON.stringify(json, null, 2);
    }

    const lines = [];
    for (const item of items) {
      if (!item || item.type !== 'message') continue;
      const role = (item.role || 'unknown').toUpperCase();
      let text = '';

      if (typeof item.content === 'string') {
        text = item.content;
      } else if (Array.isArray(item.content)) {
        text = item.content
          .map((part) => {
            if (!part) return '';
            if (typeof part.text === 'string') return part.text;
            if (typeof part.content === 'string') return part.content;
            return '';
          })
          .join(' ');
      }

      if (text) {
        lines.push(`${role}: ${text}`);
      }
    }

    return lines.join('\n');
  } catch (err) {
    console.warn('[transcript] Failed to build nice transcript, returning raw JSON.', err);
    try {
      return JSON.stringify(chatCtx.toJSON({ excludeAudio: true }), null, 2);
    } catch {
      return '';
    }
  }
}

// ------------------------------
// LiveKit Agent worker definition
// ------------------------------

const AppAgent = defineAgent({
  /**
   * prewarm runs before jobs so we can load heavier models once.
   * Here we load Silero VAD with tunable parameters.
   */
  prewarm: async (proc) => {
    console.log('[agent] Prewarming Silero VAD...');

    // VADOptions:
    // - min_speech_duration: how long speech must be (seconds) before we decide "the user really started talking"
    // - min_silence_duration: how long of silence (seconds) we wait before deciding the user finished
    // - prefix_padding_duration: how much audio (seconds) we keep before detected speech, so we don't cut the first syllable
    // - max_buffered_speech: max speech length (seconds) to keep in buffer (protects against unbounded memory)
    // - activation_threshold: 0–1; higher means VAD is stricter (fewer false positives, more likely to miss quiet speech)
    // - deactivation_threshold: similar but for ending speech; lower ends earlier, higher waits longer
    // - sample_rate: 8000 or 16000; 16000 is best quality but slightly more CPU
    proc.userData.vad = await silero.VAD.load({
      min_speech_duration: 0.15, // a bit longer than default so short noises don't trigger a turn
      min_silence_duration: 0.6, // slight pause before we treat it as end-of-turn
      prefix_padding_duration: 0.4, // keep ~0.4s of audio before detected speech
      max_buffered_speech: 90.0, // up to 90 seconds of buffered speech
      activation_threshold: 0.5, // good starting point; raise if you get false positives
      deactivation_threshold: 0.35, // end turn slightly earlier than activation to avoid long trailing silences
      sample_rate: 16000,
    });

    console.log('[agent] Silero VAD prewarmed.');
  },

  /**
   * entry is called per-call / per-room. This is where we wire the full
   * STT → LLM → TTS pipeline and attach metrics + Airtable logging.
   */
  entry: async (ctx) => {
    const callStart = Date.now();
    console.log('[agent] New call / room:', ctx.room?.name);

    // Deepgram STT (streaming)
    const stt = new deepgram.STT({
      // Model names: see Deepgram docs. Nova-3 is strong general-purpose.
      model: 'nova-3', // or adjust to nova-3-phonecall, etc.
      language: 'en', // or 'multi' / other language codes
    });

    // OpenAI LLM (streaming responses)
    const llm = new inference.LLM({
      // This uses OpenAI under the hood; see LiveKit docs for supported models
      model: 'gpt-4.1-mini',
    });

    // ElevenLabs TTS (streaming)
    const tts = new elevenlabs.TTS({
      voice: { id: process.env.ELEVEN_VOICE_ID || 'ODq5zmih8GrVes37Dizd' },
      model: process.env.ELEVEN_MODEL_ID || 'eleven_flash_v2_5',
      // Lower streaming_latency means faster time-to-first-audio at the cost of
      // slightly more choppy prosody. Good starting point is 1–2.
      streaming_latency: 1,
    });

    const vad = ctx.proc.userData.vad;

    // Voice options control barge-in, endpointing, and latency behavior.
    const session = new voice.AgentSession({
      stt,
      llm,
      tts,
      vad,
      voiceOptions: {
        // Barge-in / interruption handling:
        // When true, if the caller talks while the agent is speaking,
        // the agent will stop its TTS immediately and listen.
        allowInterruptions: true,

        // How long (in seconds) the caller must be speaking before we treat it
        // as a real interruption. Short bursts under this length are ignored.
        minInterruptionDuration: 0.2,

        // How many words of new speech we should hear before we treat it as a
        // real interruption. Helps avoid barge-in on very short noises.
        minInterruptionWords: 1,

        // Endpointing delays (seconds):
        // - minEndpointingDelay: minimal wait after VAD thinks speech ended.
        // - maxEndpointingDelay: upper bound if VAD is uncertain.
        minEndpointingDelay: 0.1,
        maxEndpointingDelay: 0.8,

        // Preemptive generation:
        // When true, the LLM starts generating while the user might still be
        // finishing a turn, which significantly reduces latency.
        preemptiveGeneration: true,

        // If you use alignment from TTS to get very precise transcripts,
        // enable this. For simplicity we keep it false here.
        useTtsAlignedTranscript: false,

        // If set (seconds), the agent can infer the user has left after
        // being silent for this long and optionally end the call.
        userAwayTimeout: null,

        // Maximum number of tool steps per turn (not used here but set safely).
        maxToolSteps: 4,

        // If false, audio spoken during an "uninterruptible" section is kept.
        // When true, it's discarded. We keep it to preserve context.
        discardAudioIfUninterruptible: false,
      },
    });

    // Metrics collection for debugging / monitoring, not required for function.
    const usageCollector = new metrics.UsageCollector();
    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      metrics.logMetrics(ev.metrics);
      usageCollector.collect(ev.metrics);
    });

    // Cost protection timer: end the call after MAX_CALL_DURATION_SECONDS.
    const maxDurationMs = MAX_CALL_DURATION_SECONDS * 1000;
    let maxDurationTimer = null;
    if (Number.isFinite(maxDurationMs) && maxDurationMs > 0) {
      maxDurationTimer = setTimeout(() => {
        console.warn(
          `[agent] Max call duration (${MAX_CALL_DURATION_SECONDS}s) reached, ending call.`,
        );
        try {
          session.shutdown({ reason: 'max_call_duration' });
        } catch (err) {
          console.error('[agent] Error shutting down session after max duration:', err);
        }
      }, maxDurationMs);
    }

    // When the job shuts down (call ends), log usage and write to Airtable.
    ctx.addShutdownCallback(async () => {
      if (maxDurationTimer) clearTimeout(maxDurationTimer);

      const callEnd = Date.now();
      const durationSeconds = Math.round((callEnd - callStart) / 1000);

      const usageSummary = usageCollector.getSummary();
      console.log('[agent] Usage summary:', JSON.stringify(usageSummary));

      // Best-effort extraction of caller number from room / participants.
      // Depending on your SIP/Twilio setup, you may want to map:
      // - Room name to caller number
      // - Participant identity or metadata to the caller's phone number
      let callerNumber = 'unknown';
      try {
        if (ctx.room && Array.isArray(ctx.room.participants)) {
          const firstRemote = ctx.room.participants.find((p) => !p.isLocal);
          if (firstRemote && typeof firstRemote.identity === 'string') {
            callerNumber = firstRemote.identity;
          }
        }
      } catch (err) {
        console.warn('[agent] Failed to infer caller number from room:', err);
      }

      const transcript = buildTranscriptFromChatContext(session.history);

      await logCallToAirtable({
        callerNumber,
        durationSeconds,
        transcript,
        createdAt: new Date(callStart).toISOString(),
      });
    });

    // Start the voice pipeline and connect to the room (this is fully streaming).
    await session.start({
      agent: new InboundVoiceAgent(),
      room: ctx.room,
      inputOptions: {
        // LiveKit noise cancellation tuned for telephony audio.
        // TelephonyBackgroundVoiceCancellation() is optimized for phone-quality audio.
        noiseCancellation: TelephonyBackgroundVoiceCancellation(),
      },
    });

    await ctx.connect();

    // Optional greeting.
    session.generateReply({
      instructions: 'Greet the caller in a friendly, concise way and ask how you can help.',
    });
  },
});

// ------------------------------
// Twilio webhook server
// ------------------------------

function startTwilioWebhookServer() {
  if (!TWILIO_AUTH_TOKEN || !PUBLIC_BASE_URL || !LIVEKIT_SIP_URI) {
    console.warn(
      '[twilio] TWILIO_AUTH_TOKEN, PUBLIC_BASE_URL, or LIVEKIT_SIP_URI missing. Twilio webhook will still start, but validation or dialing may fail.',
    );
  }

  const app = express();

  // Twilio sends webhooks as application/x-www-form-urlencoded
  app.use(
    bodyParser.urlencoded({
      extended: false,
    }),
  );

  /**
   * Outbound test: TwiML returned when the callee answers.
   * Used when we trigger a call via Twilio REST; Twilio requests this URL for TwiML.
   */
  app.get('/twilio/voice-outbound', (req, res) => {
    const response = new twilio.twiml.VoiceResponse();
    const dial = response.dial();
    dial.sip(LIVEKIT_SIP_URI);
    res.type('text/xml');
    res.send(response.toString());
  });

  /**
   * Trigger an outbound test call: your server asks Twilio to call the given number.
   * When the person answers, they are connected to the same LiveKit agent.
   * Requires: TWILIO_ACCOUNT_SID, TWILIO_PHONE_NUMBER in .env.
   * Usage: GET /outbound-test?to=+919876543210
   */
  app.get('/outbound-test', async (req, res) => {
    if (!TWILIO_ACCOUNT_SID || !TWILIO_PHONE_NUMBER) {
      return res.status(503).json({
        ok: false,
        error: 'Outbound test disabled: set TWILIO_ACCOUNT_SID and TWILIO_PHONE_NUMBER in env.',
      });
    }
    const to = req.query.to;
    if (!to || typeof to !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'Missing query parameter: to (e.g. ?to=+919876543210)',
      });
    }
    try {
      const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
      const twimlUrl = `${PUBLIC_BASE_URL.replace(/\/$/, '')}/twilio/voice-outbound`;
      const call = await client.calls.create({
        to: to.trim(),
        from: TWILIO_PHONE_NUMBER,
        url: twimlUrl,
      });
      console.log(`[twilio] Outbound test call to ${to} (Sid=${call.sid})`);
      res.json({ ok: true, callSid: call.sid, to, message: 'Call initiated. Answer the phone to talk to the agent.' });
    } catch (err) {
      console.error('[twilio] Outbound test failed:', err);
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  /**
   * Outbound test via LiveKit SIP (sip-participant.json method).
   * 1. Dispatches the voice agent to a room.
   * 2. Creates a SIP participant that dials the given number (LiveKit outbound trunk).
   * When the person answers, they join the same room as the agent.
   * Requires: LiveKit Outbound Trunk configured; SIP_OUTBOUND_TRUNK_ID or sip_trunk_id in sip-participant.json.
   * Usage: GET /outbound-test-sip?to=+919876543210
   */
  app.get('/outbound-test-sip', async (req, res) => {
    const to = req.query.to;
    if (!to || typeof to !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'Missing query parameter: to (e.g. ?to=+919876543210)',
      });
    }
    // Many SIP trunks (e.g. Twilio) expect E.164 digits only, no + or spaces
    const raw = to.trim();
    const phoneNumber = raw.replace(/\D/g, '');
    if (!phoneNumber.length) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid number: must contain digits (e.g. 919873090386 or +919873090386)',
      });
    }
    if (!SIP_OUTBOUND_TRUNK_ID || !String(SIP_OUTBOUND_TRUNK_ID).startsWith('ST_')) {
      return res.status(503).json({
        ok: false,
        error:
          'SIP outbound not configured: set SIP_OUTBOUND_TRUNK_ID in env or sip_trunk_id in sip-participant.json (LiveKit Outbound Trunk ID, e.g. ST_xxx).',
      });
    }
    const roomName = req.query.room_name?.trim() || sipParticipantDefaults.room_name || `outbound-${Date.now()}`;
    const apiUrl = getLiveKitApiUrl();
    try {
      const dispatchClient = new AgentDispatchClient(apiUrl, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
      const sipClient = new SipClient(apiUrl, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

      const dispatch = await dispatchClient.createDispatch(roomName, LIVEKIT_AGENT_NAME, {
        metadata: phoneNumber,
      });
      console.log(`[sip-outbound] Agent dispatch created for room ${roomName} (dispatchId=${dispatch.id})`);

      const sipOpts = {
        participantIdentity: sipParticipantDefaults.participant_identity || 'sip-outbound',
        participantName: sipParticipantDefaults.participant_name || 'Test Caller',
        waitUntilAnswered: sipParticipantDefaults.wait_until_answered !== false,
      };
      const participant = await sipClient.createSipParticipant(
        SIP_OUTBOUND_TRUNK_ID,
        phoneNumber,
        roomName,
        sipOpts,
      );
      console.log(`[sip-outbound] SIP participant created, calling ${phoneNumber} (room=${roomName})`);

      res.json({
        ok: true,
        roomName,
        dispatchId: dispatch.id,
        sipParticipant: participant.sipParticipantId,
        to: phoneNumber,
        message: 'Call initiated via LiveKit SIP. Answer the phone to talk to the agent.',
      });
    } catch (err) {
      console.error('[sip-outbound] Error:', err);
      const msg = err.message || String(err);
      const code = err.metadata?.['sip_status_code'] || err.code;
      res.status(500).json({
        ok: false,
        error: msg,
        sipStatusCode: code,
      });
    }
  });

  /**
   * Inbound voice webhook.
   *
   * Responsibilities:
   * - Validate the Twilio signature to ensure the request is genuine.
   * - Return TwiML that connects the call to LiveKit via SIP.
   */
  app.post('/twilio/voice', (req, res) => {
    try {
      const twilioSignature = req.headers['x-twilio-signature'];
      const authToken = TWILIO_AUTH_TOKEN;

      // Full URL Twilio used, required for signature validation.
      const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

      const isValid = twilio.validateRequest(authToken, twilioSignature, fullUrl, req.body);

      if (!isValid) {
        console.warn('[twilio] Invalid Twilio signature, rejecting request.');
        return res.status(403).send('Invalid Twilio signature');
      }

      const fromNumber = req.body.From;
      const callSid = req.body.CallSid;

      console.log(`[twilio] Inbound call from ${fromNumber} (CallSid=${callSid})`);

      const response = new twilio.twiml.VoiceResponse();

      // Dial the LiveKit SIP Ingress. You can optionally pass headers
      // so that LiveKit sees the caller number / CallSid as metadata.
      const dial = response.dial();
      dial.sip(LIVEKIT_SIP_URI);

      res.type('text/xml');
      res.send(response.toString());
    } catch (err) {
      console.error('[twilio] Error handling voice webhook:', err);
      res.status(500).send('Internal server error');
    }
  });

  app.listen(TWILIO_WEBHOOK_PORT, () => {
    console.log(
      `[twilio] Webhook server listening on port ${TWILIO_WEBHOOK_PORT}. POST ${PUBLIC_BASE_URL}/twilio/voice must be configured in Twilio.`,
    );
  });
}

// ------------------------------
// Start everything (worker + webhook)
// ------------------------------

// Start Twilio webhook HTTP server for inbound calls.
startTwilioWebhookServer();

// Start the LiveKit Agents worker that will handle SIP/LiveKit calls.
cli.runApp(
  new ServerOptions({
    // LiveKit expects this agent module to `export default` the Agent definition.
    agent: fileURLToPath(new URL('./worker.js', import.meta.url)),
    agentName: LIVEKIT_AGENT_NAME,
    wsURL: LIVEKIT_URL,
    apiKey: LIVEKIT_API_KEY,
    apiSecret: LIVEKIT_API_SECRET,
  }),
);

