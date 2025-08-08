(() => {
  const SERVER_WS_BASE = 'ws://localhost:3030/ws';

  // Create overlay
  function ensureOverlay() {
    let root = document.getElementById('meeting-assistant-overlay');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'meeting-assistant-overlay';
    root.innerHTML = `
      <div class="header">
        <div class="title">Meeting Assistant</div>
        <div class="controls">
          <button id="ma-start">Start</button>
          <button id="ma-stop" class="secondary" style="margin-left:8px;">Stop</button>
        </div>
      </div>
      <div class="body">
        <div id="ma-list"></div>
        <div class="status" id="ma-status">Idle</div>
      </div>
    `;
    document.documentElement.appendChild(root);
    return root;
  }

  function setStatus(text) {
    const el = document.getElementById('ma-status');
    if (el) el.textContent = text;
  }

  function pushAnswer(question, answer) {
    const list = document.getElementById('ma-list');
    if (!list) return;
    const item = document.createElement('div');
    item.className = 'answer';
    item.innerHTML = `<div class="q">Q: ${escapeHtml(question)}</div><div class="a">${escapeHtml(answer)}</div>`;
    list.prepend(item);
  }

  function escapeHtml(str) {
    return str.replace(/[&<>\"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  }

  let sessionId = null;
  let clientWS = null;
  let audioWS = null;
  let mediaStream = null;
  let audioContext = null;
  let workletNode = null;

  async function start() {
    ensureOverlay();
    try {
      // Connect client socket first to receive session
      clientWS = new WebSocket(`${SERVER_WS_BASE}/client/${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`);
      clientWS.onopen = () => setStatus('Connected to server');

      // Wait for session before proceeding
      const sessionReady = new Promise((resolve) => {
        clientWS.onmessage = (evt) => {
          try {
            const msg = JSON.parse(evt.data);
            if (msg.type === 'session') {
              sessionId = msg.sessionId;
              setStatus(`Session ${sessionId.slice(0,8)}…`);
              resolve();
            } else if (msg.type === 'answer') {
              pushAnswer(msg.question || 'Question', msg.answer || '');
            } else if (msg.type === 'status') {
              setStatus(msg.message);
            }
          } catch {}
        };
      });
      clientWS.onclose = () => setStatus('Disconnected');

      // Capture current tab via display media (user must select this tab)
      setStatus('Requesting tab audio…');
      mediaStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          sampleRate: 48000
        }
      });

      // Mute video track if present
      for (const track of mediaStream.getVideoTracks()) {
        track.enabled = false;
      }

      // Init audio pipeline
      audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
      await audioContext.audioWorklet.addModule(chrome.runtime.getURL('audioWorkletProcessor.js'));
      const source = audioContext.createMediaStreamSource(mediaStream);
      workletNode = new AudioWorkletNode(audioContext, 'pcm16-resampler');

      workletNode.port.onmessage = (e) => {
        if (!audioWS || audioWS.readyState !== WebSocket.OPEN) return;
        const buf = e.data; // ArrayBuffer of PCM16 mono @16k
        audioWS.send(buf);
      };

      source.connect(workletNode);

      // Ensure session ready before opening audio socket
      await sessionReady;
      audioWS = new WebSocket(`${SERVER_WS_BASE}/audio/${sessionId || 'local'}`);
      audioWS.binaryType = 'arraybuffer';
      audioWS.onopen = () => setStatus('Streaming audio…');
      audioWS.onclose = () => setStatus('Audio stream closed');
      audioWS.onerror = () => setStatus('Audio stream error');

    } catch (err) {
      console.error('start error', err);
      setStatus('Failed to start. See console.');
      stop();
    }
  }

  function stop() {
    try { if (workletNode) workletNode.disconnect(); } catch {}
    try { if (audioContext) audioContext.close(); } catch {}
    try { if (mediaStream) mediaStream.getTracks().forEach(t => t.stop()); } catch {}
    try { if (audioWS) audioWS.close(); } catch {}
    try { if (clientWS) clientWS.close(); } catch {}
    setStatus('Stopped');
  }

  function wireUi() {
    const root = ensureOverlay();
    root.querySelector('#ma-start').addEventListener('click', start);
    root.querySelector('#ma-stop').addEventListener('click', stop);
  }

  // init
  ensureOverlay();
  wireUi();
})();