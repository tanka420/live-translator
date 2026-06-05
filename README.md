# Live Event Translator Demo

Browser-based live translation app for internal use. This repository is a
customized derivative of the OpenAI Cookbook browser translation demo, adapted
for translating live international events in a browser tab into Vietnamese
captions and transcript.

Upstream source:
https://developers.openai.com/cookbook/examples/voice_solutions/realtime_translation_guide

Code provenance:
- Original inspiration: OpenAI Cookbook realtime translation guide
- Repository basis: `thanhhuy0611/live-event-translator-demo`
- Customizations in this repo: auth gate, session handling, production headers,
  VPS deployment hardening, and meeting-session UX

## What It Does

- Captures audio from a browser tab selected by the user.
- Creates a short-lived OpenAI Realtime Translation client secret on the server.
- Sends tab audio to Realtime Translation over WebRTC.
- Displays translated transcript deltas and event/debug state.
- Defaults the output language to Vietnamese.

Good demo sources:

- Official government speech or press conference.
- Federal Reserve / central bank speech.
- K-pop, athlete, or celebrity interview from an official channel.
- Product launch, keynote, or live event in English, Korean, Japanese, or Chinese.

## Setup

Create a local `.env` file in this folder:

```bash
OPENAI_API_KEY=your-openai-api-key
```

Optional:

```bash
OPENAI_TRANSLATION_MODEL=gpt-realtime-translate
OPENAI_INPUT_TRANSCRIPTION_MODEL=gpt-realtime-whisper
PORT=5173
HOST=127.0.0.1

# Optional internal login for web access
APP_AUTH_USERNAME=your-username
APP_AUTH_PASSWORD=your-password
APP_AUTH_SECRET=replace-with-a-long-random-secret
APP_AUTH_TTL_SECONDS=28800
```

For Docker or VPS deployment, set `HOST=0.0.0.0` so the app binds outside the container loopback.

## Run

```bash
npm install
npm run dev
```

Open the printed local URL, normally:

```text
http://127.0.0.1:5173
```

## VPS / Docker

Minimal VPS deployment:

```bash
docker build -t live-event-translator-demo .
docker run -d \
  --name live-event-translator-demo \
  -p 5173:5173 \
  --env-file .env \
  live-event-translator-demo
```

If you use Docker, make sure `.env` includes `HOST=0.0.0.0`.

Health check:

```text
GET /healthz
```

Recommended reverse proxy setup:

- Terminate TLS in Nginx or a similar proxy.
- Forward `X-Forwarded-Proto: https`.
- Keep the app container private on the VPS network.
- Point your monitoring to `/healthz`.

For a full VPS + subdomain + WordPress-isolation walkthrough, see
[DEPLOYMENT.md](DEPLOYMENT.md).

## End-User Flow To Record

1. Open an official event/interview/keynote tab with audio.
2. Open this app in another tab.
3. Keep `Vietnamese` selected.
4. Click `Choose event tab`.
5. Pick the source tab and enable tab audio.
6. Capture the translated transcript, audio meter, and WebRTC status.
7. Use the event log and session status to verify the session is stable.

## Validation

```bash
npm test
```

Live API smoke test, only after `.env` has `OPENAI_API_KEY`:

```bash
npm run smoke
```

## Notes For The Video

- Position this as a practical live-event translator, not a claim that OpenAI
  invented realtime translation.
- Avoid claiming perfect realtime or perfect interpretation.
- For short-form clips, use short excerpts from official/public sources and
  keep the focus on the app behavior.

## Attribution

This project builds on the OpenAI Cookbook browser translation demo and keeps
that upstream origin visible for users, contributors, and deployers.
