import dotenv from 'dotenv';
dotenv.config();

import { defineAgent, inference, metrics, voice } from '@livekit/agents';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as silero from '@livekit/agents-plugin-silero';
import { TelephonyBackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import fetch from 'node-fetch';

function envRequired(name) {
  const value = process.env[name];
  if (!value) {
    console.warn(`[config] Missing required env variable: ${name}`);
  }
  return value;
}

const AIRTABLE_PAT = envRequired('AIRTABLE_PAT');
const AIRTABLE_BASE_ID = envRequired('AIRTABLE_BASE_ID');
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || 'call_logs';
const MAX_CALL_DURATION_SECONDS = Number(process.env.MAX_CALL_DURATION_SECONDS || '900'); // default 15min

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

const AppAgent = defineAgent({
  prewarm: async (proc) => {
    console.log('[agent] Prewarming Silero VAD...');

    proc.userData.vad = await silero.VAD.load({
      min_speech_duration: 0.15,
      min_silence_duration: 0.6,
      prefix_padding_duration: 0.4,
      max_buffered_speech: 90.0,
      activation_threshold: 0.5,
      deactivation_threshold: 0.35,
      sample_rate: 16000,
    });

    console.log('[agent] Silero VAD prewarmed.');
  },

  entry: async (ctx) => {
    const callStart = Date.now();
    console.log('[agent] New call / room:', ctx.room?.name);

    const stt = new deepgram.STT({
      model: 'nova-3',
      language: 'en',
    });

    const llm = new inference.LLM({
      model: 'gpt-4.1-mini',
    });

    const tts = new elevenlabs.TTS({
      voice: { id: process.env.ELEVEN_VOICE_ID || 'ODq5zmih8GrVes37Dizd' },
      model: process.env.ELEVEN_MODEL_ID || 'eleven_flash_v2_5',
      streaming_latency: 1,
    });

    const vad = ctx.proc.userData.vad;

    const session = new voice.AgentSession({
      stt,
      llm,
      tts,
      // Omit turn detector to avoid requiring on-device model downloads.
      vad,
      voiceOptions: {
        allowInterruptions: true,
        minInterruptionDuration: 0.2,
        minInterruptionWords: 1,
        minEndpointingDelay: 0.1,
        maxEndpointingDelay: 0.8,
        preemptiveGeneration: true,
        useTtsAlignedTranscript: false,
        userAwayTimeout: null,
        maxToolSteps: 4,
        discardAudioIfUninterruptible: false,
      },
    });

    const usageCollector = new metrics.UsageCollector();
    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      metrics.logMetrics(ev.metrics);
      usageCollector.collect(ev.metrics);
    });

    const maxDurationMs = MAX_CALL_DURATION_SECONDS * 1000;
    let maxDurationTimer = null;
    if (Number.isFinite(maxDurationMs) && maxDurationMs > 0) {
      maxDurationTimer = setTimeout(() => {
        console.warn(`[agent] Max call duration (${MAX_CALL_DURATION_SECONDS}s) reached, ending call.`);
        try {
          session.shutdown({ reason: 'max_call_duration' });
        } catch (err) {
          console.error('[agent] Error shutting down session after max duration:', err);
        }
      }, maxDurationMs);
    }

    ctx.addShutdownCallback(async () => {
      if (maxDurationTimer) clearTimeout(maxDurationTimer);

      const callEnd = Date.now();
      const durationSeconds = Math.round((callEnd - callStart) / 1000);

      const usageSummary = usageCollector.getSummary();
      console.log('[agent] Usage summary:', JSON.stringify(usageSummary));

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

    await ctx.connect();

    await session.start({
      agent: new InboundVoiceAgent(),
      room: ctx.room,
      inputOptions: {
        noiseCancellation: TelephonyBackgroundVoiceCancellation(),
      },
    });

    session.generateReply({
      instructions: 'Greet the caller in a friendly, concise way and ask how you can help.',
    });
  },
});

export default AppAgent;
