import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';

const PORT = process.env.PORT || 3030;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

if (!DEEPGRAM_API_KEY) {
  console.warn('[WARN] DEEPGRAM_API_KEY is not set. Transcription will not work.');
}
if (!OPENAI_API_KEY) {
  console.warn('[WARN] OPENAI_API_KEY is not set. Answering will not work.');
}

const app = express();
app.use(cors());
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

const server = app.listen(PORT, () => {
  console.log(`[server] Listening on http://localhost:${PORT}`);
});

const wss = new WebSocketServer({ server, path: '/ws' });

/**
 * Session structure:
 * {
 *   clients: Set<WebSocket> // UI clients
 *   deepgramSocket?: WebSocket // upstream to Deepgram
 *   answeredRecently: Set<string> // dedup question text
 *   lastTranscript: string
 * }
 */
const sessions = new Map();

function getOrCreateSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      clients: new Set(),
      answeredRecently: new Set(),
      lastTranscript: ''
    });
  }
  return sessions.get(sessionId);
}

function broadcastToClients(session, payload) {
  const message = JSON.stringify(payload);
  for (const ws of session.clients) {
    try {
      ws.send(message);
    } catch (err) {
      // ignore
    }
  }
}

// Helper: establish Deepgram WS for a session
function connectDeepgram(sessionId) {
  if (!DEEPGRAM_API_KEY) return null;
  const deepgramUrl = 'wss://api.deepgram.com/v1/listen?model=nova-2&encoding=linear16&sample_rate=16000&channels=1&punctuate=true&interim_results=true&smart_format=true';
  const dg = new WebSocket(deepgramUrl, {
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` }
  });

  const session = getOrCreateSession(sessionId);

  dg.on('open', () => {
    console.log(`[deepgram] connected for session ${sessionId}`);
  });

  dg.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      // Deepgram sends { type: 'Results', channel: { alternatives: [{ transcript, confidence, words }], is_final } }
      if (msg.type === 'Results' && msg.channel) {
        const alt = msg.channel.alternatives?.[0];
        const transcript = alt?.transcript || '';
        const isFinal = Boolean(msg.is_final);
        if (!transcript) return;

        session.lastTranscript = transcript;
        broadcastToClients(session, { type: 'transcript', transcript, isFinal });

        if (isFinal) {
          const q = extractQuestion(transcript);
          if (q && !hasAnsweredRecently(session, q)) {
            markAnswered(session, q);
            try {
              const answer = await generateAnswer(q);
              broadcastToClients(session, { type: 'answer', question: q, answer });
            } catch (err) {
              console.error('[answer] error', err);
            }
          }
        }
      }
    } catch (err) {
      // ignore parse errors
    }
  });

  dg.on('close', () => {
    console.log(`[deepgram] closed for session ${sessionId}`);
  });

  dg.on('error', (err) => {
    console.error('[deepgram] error', err);
  });

  return dg;
}

function hasAnsweredRecently(session, questionText) {
  const key = questionText.trim().toLowerCase();
  return session.answeredRecently.has(key);
}

function markAnswered(session, questionText) {
  const key = questionText.trim().toLowerCase();
  session.answeredRecently.add(key);
  // expire after 5 minutes
  setTimeout(() => session.answeredRecently.delete(key), 5 * 60 * 1000);
}

function extractQuestion(text) {
  if (!text) return null;
  const normalized = text.trim();
  // If contains '?' take last sentence ending with '?'
  const matches = normalized.match(/[^?]*\?+/g);
  if (matches && matches.length > 0) {
    return matches[matches.length - 1].trim();
  }
  // Heuristic: starts with interrogative and ends with sentence boundary
  const interrogatives = /^(what|why|how|when|where|who|whom|whose|which|can|could|would|should|is|are|do|does|did)\b/i;
  if (interrogatives.test(normalized) && normalized.split(/\s+/).length >= 3) {
    return normalized;
  }
  return null;
}

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

async function generateAnswer(question) {
  if (!openai) return '[Answer unavailable: OPENAI_API_KEY not configured]';
  const system = {
    role: 'system',
    content: 'You are a concise, helpful real-time meeting assistant. Answer user questions directly and practically in 1-5 sentences. If the question lacks context, provide brief assumptions.'
  };
  const user = { role: 'user', content: question };
  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [system, user],
    temperature: 0.2,
    max_tokens: 300
  });
  return resp.choices?.[0]?.message?.content?.trim() || 'No answer.';
}

// We multiplex two subpaths under one WS server path `/ws`: `/ws/audio/:sessionId` and `/ws/client/:sessionId`
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname; // e.g., /ws/audio/123
  const parts = pathname.split('/').filter(Boolean); // ['ws','audio','123']
  const role = parts[1];
  const sessionId = parts[2] || uuidv4();
  const session = getOrCreateSession(sessionId);

  if (role === 'client') {
    session.clients.add(ws);
    ws.send(JSON.stringify({ type: 'session', sessionId }));
    ws.send(JSON.stringify({ type: 'status', message: 'connected' }));

    ws.on('close', () => {
      session.clients.delete(ws);
    });

    ws.on('message', (data) => {
      // allow client to send simple pings or clear commands
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'clear_cache') {
          session.answeredRecently.clear();
        }
      } catch (err) {}
    });
    return;
  }

  if (role === 'audio') {
    // Connect to Deepgram upstream
    const deepgramSocket = connectDeepgram(sessionId);
    session.deepgramSocket = deepgramSocket;

    ws.on('message', (data, isBinary) => {
      // Forward raw PCM16 16k mono frames to Deepgram
      if (deepgramSocket && deepgramSocket.readyState === WebSocket.OPEN) {
        deepgramSocket.send(data, { binary: true });
      }
    });

    ws.on('close', () => {
      if (deepgramSocket && deepgramSocket.readyState === WebSocket.OPEN) {
        try {
          deepgramSocket.send(JSON.stringify({ type: 'CloseStream' }));
          deepgramSocket.close();
        } catch (err) {}
      }
    });

    return;
  }

  // Unknown role
  ws.close();
});