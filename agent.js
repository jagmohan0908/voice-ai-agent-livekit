import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import bodyParser from 'body-parser';
import twilio from 'twilio';
import { cli, ServerOptions } from '@livekit/agents';
import { fileURLToPath } from 'node:url';

// ------------------------------
// Config
// ------------------------------

function env(name, def) {
  const v = process.env[name];
  if (!v && def === undefined) console.warn(`[config] Missing: ${name}`);
  return v || def;
}

const LIVEKIT_URL = env('LIVEKIT_URL');
const LIVEKIT_API_KEY = env('LIVEKIT_API_KEY');
const LIVEKIT_API_SECRET = env('LIVEKIT_API_SECRET');
const LIVEKIT_AGENT_NAME = env('LIVEKIT_AGENT_NAME', 'voice-agent');
const LIVEKIT_SIP_URI = env('LIVEKIT_SIP_URI');

const PUBLIC_BASE_URL = env('PUBLIC_BASE_URL');
const PORT = Number(process.env.PORT || process.env.TWILIO_WEBHOOK_PORT || '3000');
const TWILIO_AUTH_TOKEN = env('TWILIO_AUTH_TOKEN');
const TWILIO_ACCOUNT_SID = env('TWILIO_ACCOUNT_SID');
const TWILIO_PHONE_NUMBER = env('TWILIO_PHONE_NUMBER');

// ------------------------------
// HTTP: Twilio webhook + trigger outbound call
// ------------------------------

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// When a call is connected (outbound: user answered), Twilio asks for TwiML. We reply: dial LiveKit SIP.
app.get('/twilio/voice', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.dial().sip(LIVEKIT_SIP_URI);
  res.type('text/xml').send(twiml.toString());
});

// Start an outbound call: Twilio calls `to`; when they answer, Twilio uses the URL above → LiveKit → AI.
app.get('/call', async (req, res) => {
  const to = req.query.to;
  if (!to || typeof to !== 'string') {
    return res.status(400).json({ ok: false, error: 'Missing ?to=+1234567890' });
  }
  if (!TWILIO_ACCOUNT_SID || !TWILIO_PHONE_NUMBER) {
    return res.status(503).json({
      ok: false,
      error: 'Set TWILIO_ACCOUNT_SID and TWILIO_PHONE_NUMBER in env.',
    });
  }
  try {
    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    const url = `${PUBLIC_BASE_URL.replace(/\/$/, '')}/twilio/voice`;
    const call = await client.calls.create({
      to: to.trim(),
      from: TWILIO_PHONE_NUMBER,
      url,
    });
    console.log('[twilio] Outbound call to', to.trim(), 'Sid=', call.sid);
    res.json({ ok: true, callSid: call.sid, to: to.trim(), message: 'Calling. Answer to talk to the AI.' });
  } catch (err) {
    console.error('[twilio]', err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// Inbound: when someone calls your Twilio number. Same TwiML: connect to LiveKit.
app.post('/twilio/voice', (req, res) => {
  const sig = req.headers['x-twilio-signature'];
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  if (!twilio.validateRequest(TWILIO_AUTH_TOKEN, sig, url, req.body)) {
    return res.status(403).send('Invalid signature');
  }
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.dial().sip(LIVEKIT_SIP_URI);
  res.type('text/xml').send(twiml.toString());
});

app.listen(PORT, () => {
  console.log(`[server] Port ${PORT}. Outbound: GET ${PUBLIC_BASE_URL}/call?to=+1234567890`);
});

// ------------------------------
// LiveKit agent worker (OpenAI + ElevenLabs in worker.js)
// ------------------------------

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(new URL('./worker.js', import.meta.url)),
    agentName: LIVEKIT_AGENT_NAME,
    wsURL: LIVEKIT_URL,
    apiKey: LIVEKIT_API_KEY,
    apiSecret: LIVEKIT_API_SECRET,
  }),
);
