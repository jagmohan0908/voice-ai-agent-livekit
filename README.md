## Inbound Voice Agent (LiveKit + Twilio + Deepgram + OpenAI + ElevenLabs + Airtable)

This project is a **self-hosted inbound voice agent** that:

- **Answers inbound phone calls** coming from Twilio via SIP into LiveKit
- **Has a realtime AI conversation** using:
  - Deepgram for **speech-to-text (STT)**
  - OpenAI for the **LLM**
  - ElevenLabs for **text-to-speech (TTS)**
  - Silero for **Voice Activity Detection (VAD)** and turn detection
- **Logs every call to Airtable**, including:
  - `caller_number`
  - `duration_seconds`
  - `transcript`
  - `created_at`

Everything runs in a single entry file: `agent.js`.

---

### Files in this project

- **`agent.js`**: Main entry point. Starts:
  - The LiveKit Agents worker (the AI voice agent that joins calls)
  - An Express HTTP server for Twilio webhooks with signature validation
- **`.env.example`**: Template for all required environment variables (no secrets included).
- **`.gitignore`**: Ensures `.env` and other local artifacts are not committed.
- **`package.json`**: Node.js dependency management and start script.
- **`requirements.txt`**: Text list of dependencies (for reference only; use `npm install`).
- **`README.md`**: You are here.

---

### Environment variables (and where to get them)

Copy `.env.example` to `.env` and fill in the values.

- **`LIVEKIT_URL`**
  - Your LiveKit Cloud URL (e.g. `wss://your-project.livekit.cloud`).
  - Get this from the LiveKit Cloud console.

- **`LIVEKIT_API_KEY`**
- **`LIVEKIT_API_SECRET`**
  - API key/secret pair with permissions for Agents to connect and join rooms.
  - Create from **LiveKit Cloud → API Keys**.

- **`LIVEKIT_AGENT_NAME`**
  - Human-readable name for this agent worker (e.g. `inbound-voice-agent`).
  - Used only for identification in logs/monitoring.

- **`DEEPGRAM_API_KEY`**
  - Your Deepgram API key, required by `@livekit/agents-plugin-deepgram`.
  - Get from your Deepgram dashboard.

- **`OPENAI_API_KEY`**
  - OpenAI API key to call the LLM (e.g. `gpt-4.1-mini` or similar).
  - Get from the OpenAI dashboard under API keys.

- **`ELEVEN_API_KEY`**
  - ElevenLabs API key for TTS.
  - Get from your ElevenLabs account dashboard.

- **`ELEVEN_VOICE_ID`**
  - The ElevenLabs voice ID to use (e.g. `ODq5zmih8GrVes37Dizd`).
  - Get from ElevenLabs when you select a voice.

- **`ELEVEN_MODEL_ID`**
  - ElevenLabs model for streaming TTS, e.g. `eleven_flash_v2_5`.
  - See ElevenLabs docs for available models.

- **`AIRTABLE_PAT`**
  - Airtable Personal Access Token with permission to write to the base.
  - Create from Airtable account settings.

- **`AIRTABLE_BASE_ID`**
  - ID of the Airtable base that contains your `call_logs` table.
  - Find this in the Airtable API docs for your base.

- **`AIRTABLE_TABLE_NAME`**
  - Table name to insert call logs into, e.g. `call_logs`.
  - Must match the table you created in Airtable.

- **`MAX_CALL_DURATION_SECONDS`**
  - **Cost protection limit**.
  - Maximum duration of any call in seconds (e.g. `900` for 15 minutes).
  - After this, the agent will end the call to avoid runaway costs.

- **`PUBLIC_BASE_URL`**
  - Public HTTPS base URL of this server, e.g. `https://your-domain.example.com`.
  - Twilio will call `PUBLIC_BASE_URL + /twilio/voice` for inbound voice webhooks.
  - Typically this points to your VPS domain or reverse proxy (nginx, Caddy, etc.).

- **`TWILIO_WEBHOOK_PORT`**
  - Local port that the Express server listens on (e.g. `3000`).
  - Your reverse proxy should forward `https://your-domain.example.com/twilio/voice`
    to `http://127.0.0.1:3000/twilio/voice`.

- **`TWILIO_AUTH_TOKEN`**
  - Your Twilio **Auth Token**, used only for validating Twilio webhooks.
  - Get from Twilio Console under **Account → API Keys & Tokens**.

- **`LIVEKIT_SIP_URI`**
  - SIP URI for your LiveKit **SIP Ingress**.
  - Example: `sip:ingress-id@sip.livekit.cloud`
  - You will get this when you create a SIP Ingress in LiveKit Cloud.
  - Twilio will be instructed via TwiML to connect the incoming call to this SIP URI.

---

### Airtable table structure

Create an Airtable **table named `call_logs`** with these fields:

- **`caller_number`** (single line text)
- **`duration_seconds`** (number)
- **`transcript`** (long text)
- **`created_at`** (date or date & time)

The code expects those field names exactly. Each completed call will insert **one row**.

---

### How the call flow works (high level)

1. **Caller dials your Twilio number**.
2. Twilio hits your **Voice webhook** (`POST /twilio/voice` on this server).
3. The webhook:
   - Validates the request using Twilio’s signature and your `TWILIO_AUTH_TOKEN`.
   - Returns TwiML instructing Twilio to connect the call via SIP to `LIVEKIT_SIP_URI`.
4. Twilio connects the audio stream to LiveKit via SIP Ingress.
5. LiveKit creates a room and schedules a job for this Agent worker.
6. The **LiveKit Agents worker (inside `agent.js`)**:
   - Joins the room.
   - Builds a fully streaming pipeline:
     - **Deepgram STT** (ears) → **OpenAI LLM** (brain) → **ElevenLabs TTS** (voice)
   - Uses **Silero VAD** + turn detection to know when to listen vs. speak.
   - Enables **barge-in**: if the caller talks while the agent speaks, the agent stops and listens.
   - Uses **preemptive generation** and streaming TTS so responses start as soon as the first tokens arrive.
7. When the call ends:
   - The worker gathers:
     - Call duration
     - A full transcript from the conversation history
     - The caller number (best-effort, based on room/participant metadata)
   - It then **logs a row to Airtable** using your `AIRTABLE_PAT` and `AIRTABLE_BASE_ID`.
   - If Airtable fails, the error is logged, but the call itself is **not** affected.

---

### Checklist: what you must set up

**LiveKit**
- **Create a LiveKit Cloud account**.
- Create a project and note:
  - `LIVEKIT_URL`
  - `LIVEKIT_API_KEY`
  - `LIVEKIT_API_SECRET`
- In LiveKit Cloud:
  - Create a **SIP Ingress** and note its SIP URI → set `LIVEKIT_SIP_URI`.

**Deepgram**
- Create a Deepgram account.
- Generate an API key → `DEEPGRAM_API_KEY`.

**OpenAI**
- Create an OpenAI account.
- Generate an API key → `OPENAI_API_KEY`.

**ElevenLabs**
- Create an ElevenLabs account.
- Generate an API key → `ELEVEN_API_KEY`.
- Choose a voice and copy its voice ID → `ELEVEN_VOICE_ID`.
- Choose a streaming model → `ELEVEN_MODEL_ID` (e.g. `eleven_flash_v2_5`).

**Twilio (SIP + webhook)**
- Create a Twilio account and buy a phone number.
- Under **Voice**:
  - Configure the number’s **Voice & Fax → A CALL COMES IN** webhook
    to point to: `POST https://YOUR_DOMAIN/twilio/voice`.
  - Ensure this URL forwards to your VPS (e.g. via nginx) and then to the
    Express server running on `TWILIO_WEBHOOK_PORT`.
- Configure Twilio to:
  - Use the **TwiML** returned by `/twilio/voice`, which will:
    - `<Dial><Sip>` to your `LIVEKIT_SIP_URI`.
- Copy your Twilio **Auth Token** → `TWILIO_AUTH_TOKEN`.

**Airtable**
- Create an Airtable base.
- Create the `call_logs` table with the fields exactly as described above.
- Create a **Personal Access Token (PAT)** with access to that base.
  - Put the token in `AIRTABLE_PAT`.
  - Put the base ID in `AIRTABLE_BASE_ID`.

**Server / VPS**
- Provision a VPS (e.g. Ubuntu + Node.js >= 20).
- Clone or copy this project to the VPS.
- Install dependencies: `npm install`.
- Copy `.env.example` → `.env` and fill in all fields.
- Ensure port `TWILIO_WEBHOOK_PORT` is reachable via your reverse proxy.

---

### Running the agent

```bash
npm install
npm start
```

This will:

- Start the **LiveKit Agents worker** that connects to LiveKit and handles calls.
- Start the **Express server** that validates Twilio webhooks and returns TwiML with the SIP dial.

Keep this process running using something like:

- `pm2`
- `systemd`
- `forever`
- a Docker container with a restart policy

There are **no serverless assumptions** – this is meant to be a long-running process on your VPS.

---

### Notes on VAD tuning and barge-in

Inside `agent.js` you will find:

- **Silero VAD options** with inline comments for:
  - `min_speech_duration`
  - `min_silence_duration`
  - `prefix_padding_duration`
  - `max_buffered_speech`
  - `activation_threshold`
  - `deactivation_threshold`
  - `sample_rate`
- **Voice options** controlling interruption / barge-in:
  - `allowInterruptions`
  - `minInterruptionDuration`
  - `minInterruptionWords`
  - `preemptiveGeneration`
  - `maxEndpointingDelay` / `minEndpointingDelay`

You can tune these to trade off between:

- Not cutting the caller off mid-sentence
- Not waiting too long on awkward silences
- How aggressively the agent stops talking when the caller interrupts

