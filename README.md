# Meeting Assistant (MVP)

Real-time meeting copilot that listens to your meeting tab, transcribes in real time, detects questions, generates answers with an LLM, and overlays answers on top of your meeting.

## What you get
- Node.js server (`/server`) with WebSocket endpoints for audio and UI clients
- Deepgram streaming transcription (low-latency)
- Question detection heuristics
- OpenAI for concise answers
- Chrome extension (`/extension`) that captures tab audio via getDisplayMedia, resamples to 16k PCM16, streams to the server, and overlays answers

## Prerequisites
- Node.js 18+
- Chrome-based browser for the extension
- API keys:
  - Deepgram (`DEEPGRAM_API_KEY`) for real-time transcription
  - OpenAI (`OPENAI_API_KEY`) for answer generation

## Setup
1. Server
   - Copy env: `cp server/.env.example server/.env` and fill your keys
   - Install deps: `cd server && npm install`
   - Run: `npm start`
   - Health check: `curl http://localhost:3030/health`

2. Extension
   - Open Chrome → Extensions → enable Developer Mode
   - Load unpacked → select the `/extension` folder
   - Navigate to a meeting in the browser (Google Meet, Zoom Web, Teams Web)
   - Use the floating overlay in-page → click Start → pick "This Tab"

## Notes
- Audio capture uses `getDisplayMedia`; you must select the current tab for audio.
- For native desktop apps (Zoom/Teams desktop), use the browser versions for this MVP. A desktop app (Electron) and virtual audio device can be added later.
- Latency depends on network and API RTT. This MVP focuses on simplicity with good-enough real-time behavior.

## Security
- Keep your API keys private. Do not ship them in the extension.
- The extension only talks to `ws://localhost:3030` by default. Adjust the host in `contentScript.js` for remote deployments (use wss and valid certs).

## Roadmap
- Better question detection and context tracking
- Partial/interim answer streaming (as soon as question is detected)
- Per-meeting memory (summaries, follow-ups)
- Electron desktop overlay for native meeting apps
- SSO and multi-user sessions
