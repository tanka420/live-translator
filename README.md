# Live Event Translator Demo

Local demo for recording an AI by Huy long-form tutorial. It is based on the
official OpenAI Cookbook browser translation demo, with light UI copy changes
for the use case: translating live international events in a browser tab into
Vietnamese speech and captions.

Source:
https://developers.openai.com/cookbook/examples/voice_solutions/realtime_translation_guide

## What It Does

- Captures audio from a browser tab selected by the user.
- Creates a short-lived OpenAI Realtime Translation client secret on the server.
- Sends tab audio to Realtime Translation over WebRTC.
- Plays translated speech locally and displays translated transcript deltas.
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
```

## Run

```bash
npm install
npm run dev
```

Open the printed local URL, normally:

```text
http://127.0.0.1:5173
```

## End-User Flow To Record

1. Open an official event/interview/keynote tab with audio.
2. Open this app in another tab.
3. Keep `Vietnamese` selected.
4. Click `Choose event tab`.
5. Pick the source tab and enable tab audio.
6. Capture the translated audio, transcript, audio meter, and WebRTC status.
7. Adjust the audio mix so the translated voice is dominant.

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
