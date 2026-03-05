# Voice AI: Twilio → LiveKit → OpenAI + ElevenLabs

**Simple flow:** Twilio number connects to LiveKit via SIP. When there’s a call (outbound or inbound), the OpenAI agent answers and speaks with ElevenLabs voice.

## High-level design

```
User’s phone  ←→  Twilio  ←→  LiveKit (SIP)  ←→  Agent (OpenAI + ElevenLabs)
```

- **Outbound (for now):** You trigger a call → Twilio calls the user → they answer → TwiML connects the call to LiveKit SIP → agent joins the room and talks (ElevenLabs).
- **Inbound (optional):** Someone calls your Twilio number → same TwiML → LiveKit → same agent.

Pipeline in the agent: **Deepgram (hear)** → **OpenAI (reply)** → **ElevenLabs (speak)**.

## Setup

1. **LiveKit Cloud:** Create a project. Note `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`. Create a **SIP Ingress** and set `LIVEKIT_SIP_URI`.

2. **Twilio:** Buy a number. Get `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`.  
   For **inbound**: set the number’s voice webhook to `POST https://YOUR_PUBLIC_BASE_URL/twilio/voice`.

3. **APIs:** Get keys for **Deepgram**, **OpenAI**, **ElevenLabs**. Put them in `.env` (see `.env.example`).

4. Copy `.env.example` to `.env` and fill in all values. `PUBLIC_BASE_URL` must be the public URL of your deployed app (e.g. `https://your-app.onrender.com`).

## Run

```bash
npm install
npm start
```

Starts the HTTP server (Twilio webhooks + `/call`) and the LiveKit agent worker.

## Trigger an outbound call

Open in a browser or call with curl (use a real number in E.164, e.g. `+919876543210`):

```
https://YOUR_APP_URL/call?to=+919876543210
```

Twilio will call that number. When they answer, the call is connected to LiveKit and the AI speaks with ElevenLabs voice.

## Env vars (summary)

| Variable | Purpose |
|----------|--------|
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | LiveKit project |
| `LIVEKIT_AGENT_NAME` | Agent name in LiveKit (default `voice-agent`) |
| `LIVEKIT_SIP_URI` | SIP Ingress URI (Twilio dials this) |
| `PUBLIC_BASE_URL` | Public URL of this app |
| `TWILIO_AUTH_TOKEN`, `TWILIO_ACCOUNT_SID`, `TWILIO_PHONE_NUMBER` | Twilio |
| `DEEPGRAM_API_KEY` | Speech-to-text |
| `OPENAI_API_KEY` | LLM |
| `ELEVEN_API_KEY`, `ELEVEN_VOICE_ID`, `ELEVEN_MODEL_ID` | Voice (ElevenLabs) |
| `MAX_CALL_DURATION_SECONDS` | Optional; default 900 (15 min) |

## Files

- **`agent.js`** – HTTP server (Twilio webhooks, `GET /call`) and starts the LiveKit worker.
- **`worker.js`** – Voice agent: Deepgram STT → OpenAI LLM → ElevenLabs TTS, joins the room when a call is connected.
