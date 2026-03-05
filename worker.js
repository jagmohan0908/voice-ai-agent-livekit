import dotenv from 'dotenv';
dotenv.config();

import { defineAgent, inference, voice } from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';

// ------------------------------
// Voice agent: OpenAI (brain) + ElevenLabs (voice). Deepgram hears the user.
// Kept lightweight for Render (no heavy VAD/noise models).
// ------------------------------

class VoiceAgent extends voice.Agent {
  constructor() {
    super({
      instructions: `
You are Neha, a calm and friendly female voice assistant for Siya Ayurveda, speaking over the phone.
Callers may speak Hindi, English, or Hinglish (a mix) and are usually asking about Siya Ayurveda products or orders.
Always reply in the same language and style they use (Hindi, English, or mixed),
keep sentences short and soothing, avoid technical jargon, speak a little slower than normal so it is clear on the phone,
and never invent product or order details.
`.trim(),
    });
  }
}

export default defineAgent({
  // No prewarm/VAD here to avoid runner initialization timeouts on Render.

  entry: async (ctx) => {
    console.log('[agent] Call started:', ctx.room?.name);

    // Multilingual STT so user can speak Hindi, English, or Hinglish.
    const stt = new deepgram.STT({ model: 'nova-3', language: 'multi' });
    const llm = new inference.LLM({ model: 'gpt-4.1-mini' });
    const tts = new elevenlabs.TTS({
      voice: { id: process.env.ELEVEN_VOICE_ID || 'ODq5zmih8GrVes37Dizd' },
      model: process.env.ELEVEN_MODEL_ID || 'eleven_flash_v2_5',
      // Slightly higher latency for smoother, clearer speech (better for Render/telephony).
      streamingLatency: 2,
      // Make the voice a bit slower and smoother than default.
      voiceSettings: {
        stability: 0.7,
        similarity_boost: 0.9,
        style: 0.3,
        speed: 0.9,
        use_speaker_boost: true,
      },
    });

    const session = new voice.AgentSession({
      stt,
      llm,
      tts,
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

    const maxSec = Number(process.env.MAX_CALL_DURATION_SECONDS || '900');
    let timer = null;
    if (maxSec > 0) {
      timer = setTimeout(() => {
        try {
          session.shutdown({ reason: 'max_duration' });
        } catch (e) {
          console.error('[agent] Shutdown error:', e);
        }
      }, maxSec * 1000);
    }

    ctx.addShutdownCallback(() => {
      if (timer) clearTimeout(timer);
      console.log('[agent] Call ended.');
    });

    await ctx.connect();
    await session.start({
      agent: new VoiceAgent(),
      room: ctx.room,
      // No noiseCancellation to avoid heavy model downloads on Render.
    });
    session.generateReply({
      instructions:
        'In Hindi, say: "Mera naam Neha hai, main Siya Ayurveda se baat kar rahi hoon. Aapko kis cheez mein madad chahiye?"',
    });
  },
});
