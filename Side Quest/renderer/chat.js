const transcript = document.getElementById('transcript');
// MEMORY: cap the dialogue transcript DOM so a multi-hour session doesn't grow the chat renderer
// unbounded (the leak behind the freeze — the sheep rail was already capped at 200, but the transcript
// grew forever). A MutationObserver on childList covers EVERY append path in one place; it only ever
// removes the OLDEST turns (firstChild), never the newest streaming turn (last child), so an in-flight
// reply and its currentAiTurnDiv reference are untouched. 400 turns is far more than anyone scrolls back.
const TRANSCRIPT_CAP = 400;
try {
  new MutationObserver(() => {
    while (transcript.children.length > TRANSCRIPT_CAP) transcript.removeChild(transcript.firstChild);
  }).observe(transcript, { childList: true });
} catch (e) { /* observer unsupported → transcript simply isn't capped */ }
const input = document.getElementById('input');
const sheepStream = document.getElementById('sheep-stream');
const dashboardToggle = document.getElementById('dashboard-toggle');
const dashboardOverlay = document.getElementById('dashboard-overlay');
const dashboardClose = document.getElementById('dashboard-close');
const dashboardBody = document.getElementById('dashboard-body');
const attachBtn = document.getElementById('attach-btn');
const attachInput = document.getElementById('attach-input');
const attachmentsBar = document.getElementById('attachments-bar');
const browserBtn = document.getElementById('browser-btn');
const browserStatus = document.getElementById('browser-status');
const editorBtn = document.getElementById('editor-btn');
if (editorBtn && window.sq && (window.sq.openWorkspace || window.sq.openEditor)) {
  // ⊞ opens the My Workspace workbench (the Editor lives inside it now); falls back to the
  // standalone Editor window if workspace isn't available.
  editorBtn.addEventListener('click', () => (window.sq.openWorkspace || window.sq.openEditor)());
}

const canvasBtn = document.getElementById('canvas-btn');
if (canvasBtn && window.sq && window.sq.openCanvas) {
  // ◫ opens Zoe's Canvas — her own window for deliverables + visual aids (its own window, NOT a tab
  // inside the operator workbench).
  canvasBtn.addEventListener('click', () => window.sq.openCanvas());
}

// --- Browser layer UI ---
let browserConnected = false;
function setBrowserStatus(s) {
  if (!browserStatus) return;
  browserConnected = !!(s && s.connected);
  if (browserConnected) {
    const active = s.activeTitle || s.activeUrl || '(no active tab)';
    const short = active.length > 36 ? active.slice(0, 36) + '…' : active;
    browserStatus.textContent = `linked · ${short}`;
    browserStatus.classList.add('connected');
    browserStatus.classList.remove('disconnected');
    browserStatus.title = `Active: ${s.activeUrl || ''}\nOpen tabs: ${s.tabCount || 0}`;
    if (browserBtn) browserBtn.textContent = '⊖ unlink';
  } else {
    browserStatus.textContent = 'offline';
    browserStatus.classList.add('disconnected');
    browserStatus.classList.remove('connected');
    browserStatus.title = '';
    if (browserBtn) browserBtn.textContent = '⊕ browser';
  }
}
if (browserBtn) {
  browserBtn.addEventListener('click', async () => {
    browserBtn.disabled = true;
    try {
      if (browserConnected) {
        await window.sq.browserDisconnect();
        setBrowserStatus({ connected: false });
      } else {
        const r = await window.sq.browserLaunch();
        if (r && r.ok) setBrowserStatus({ connected: true, ...(r.status || {}) });
        else {
          alert('Could not launch shared browser: ' + (r?.reason || 'unknown'));
        }
      }
    } finally {
      browserBtn.disabled = false;
    }
  });
}
if (window.sq && window.sq.onBrowserStatus) {
  window.sq.onBrowserStatus((s) => setBrowserStatus(s));
}

// --- Echo suit status (read-only indicator; she auto-attaches to the Echo app you run) ---
const echoStatus = document.getElementById('echo-status');
function setEchoStatus(s) {
  if (!echoStatus) return;
  const connected = !!(s && s.connected);
  if (connected) {
    echoStatus.textContent = `echo · ${s.tools || 0} tools`;
    echoStatus.classList.add('connected');
    echoStatus.classList.remove('disconnected');
    echoStatus.title = `Echo suit attached — ${s.tools || 0} tools available`;
  } else {
    echoStatus.textContent = 'echo: offline';
    echoStatus.classList.add('disconnected');
    echoStatus.classList.remove('connected');
    echoStatus.title = 'Echo suit — open the Echo app to connect';
  }
}
if (window.sq && window.sq.onEchoStatus) {
  window.sq.onEchoStatus((s) => setEchoStatus(s));
}

// --- Code-running indicator (analyze_data / python) ---
// Up to 3 cloud-operator runs overlap, so key by run-id in a Set — a single boolean would let one run's
// 'end' clear another run's chip. Shows 'running…' (or 'running · N' when several overlap), else 'idle'.
const codeStatus = document.getElementById('code-status');
const activeCodeRuns = new Set();
function renderCodeStatus() {
  if (!codeStatus) return;
  const n = activeCodeRuns.size;
  if (n > 0) {
    codeStatus.textContent = n > 1 ? `running · ${n}` : 'running…';
    codeStatus.classList.add('running');
    codeStatus.classList.remove('disconnected');
    codeStatus.title = `${n} code run(s) executing`;
  } else {
    codeStatus.textContent = 'idle';
    codeStatus.classList.add('disconnected');
    codeStatus.classList.remove('running');
    codeStatus.title = 'no code running';
  }
}
if (window.sq && window.sq.onCodeStatus) {
  window.sq.onCodeStatus((s) => {
    if (!s || !s.id) return;
    if (s.phase === 'start') activeCodeRuns.add(s.id);
    else if (s.phase === 'end') activeCodeRuns.delete(s.id);
    renderCodeStatus();
  });
}

// --- Swarm-in-flight indicator (the "swarm the LA roster" verb: N parallel workers draining a roster) ---
// Latest-wins status object; shows 'swarm · Nw done/target' while out, else 'swarm: off'.
const swarmStatus = document.getElementById('swarm-status');
function setSwarmStatus(s) {
  if (!swarmStatus) return;
  if (s && s.active) {
    const prog = (s.done != null && s.target != null) ? ` ${s.done}/${s.target}` : '';
    swarmStatus.textContent = `swarm · ${s.workers || 0}w${prog}`;
    swarmStatus.classList.add('swarming');
    swarmStatus.classList.remove('disconnected');
    swarmStatus.title = `swarm in flight${s.state ? ' — ' + s.state : ''}`;
  } else {
    swarmStatus.textContent = 'swarm: off';
    swarmStatus.classList.add('disconnected');
    swarmStatus.classList.remove('swarming');
    swarmStatus.title = 'no swarm running';
  }
}
if (window.sq && window.sq.onSwarmStatus) {
  window.sq.onSwarmStatus((s) => setSwarmStatus(s));
}
// Initial status query
if (window.sq && window.sq.browserStatus) {
  window.sq.browserStatus().then(s => setBrowserStatus(s)).catch(() => {});
}

const pendingAttachments = [];  // [{ name, text } | { name, mime, dataUrl, image:true }]

function renderAttachments() {
  attachmentsBar.innerHTML = '';
  pendingAttachments.forEach((a, idx) => {
    const chip = document.createElement('span');
    chip.className = 'attachment-chip';
    const label = document.createElement('span');
    label.textContent = a.image ? `${a.name} (image)` : `${a.name} (${(a.text || '').length} ch)`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      pendingAttachments.splice(idx, 1);
      renderAttachments();
    });
    chip.appendChild(label);
    chip.appendChild(remove);
    attachmentsBar.appendChild(chip);
  });
}

if (attachBtn) attachBtn.addEventListener('click', () => attachInput.click());
if (attachInput) attachInput.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  for (const f of files) {
    try {
      if (f.type && f.type.startsWith('image/')) {
        // Image → read as a base64 data URL so Zoe can actually SEE it (vision).
        const dataUrl = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result);
          fr.onerror = reject;
          fr.readAsDataURL(f);
        });
        pendingAttachments.push({ name: f.name, mime: f.type, dataUrl, image: true });
      } else {
        // Carry the OS path too (webUtils via preload — Electron removed File.path): main-side
        // extraction needs it for binary formats (.docx/.pdf/.xlsx) that f.text() reads as garbage.
        const path = (window.sq && window.sq.pathForFile) ? window.sq.pathForFile(f) : null;
        const text = await f.text();
        const truncated = text.length > 50000 ? text.slice(0, 50000) : text;
        pendingAttachments.push({ name: f.name, text: truncated, path });
      }
    } catch (err) {
      console.error('attach failed:', err);
    }
  }
  attachInput.value = '';
  renderAttachments();
});

let currentAiTurnDiv = null;     // the .turn.ai div for the in-progress AI response
let currentAiSaidNode = null;    // the .said span where streamed tokens go
let sending = false;
// MAIN CHAT = user-prompted dialogue ONLY. A reply to the user's message streams into
// the transcript; her UNPROMPTED utterances (heartbeat/autonomous) are diverted to the
// sheep panel instead — until real autonomous chatting is good enough to promote back.
let promptedReplyPending = false;  // true between a user send() and that reply's complete
let unpromptedActive = false;      // the in-flight stream is an autonomous utterance (LEGACY heuristic)
let sheepBufs = {};                // per-stream buffers for DISCRIMINATED autonomous streams
let unpromptedBuffer = '';         // accumulates an autonomous utterance for the sheep panel
let lastSheepThoughtId = null;     // dedup guard so a thought isn't filed to sheep twice

function autosizeInput() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
}
input.addEventListener('input', autosizeInput);

function nearBottom() {
  return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 100;
}

function scrollMaybe() {
  if (nearBottom()) {
    transcript.scrollTop = transcript.scrollHeight;
  }
}

function makeAiTurn() {
  const div = document.createElement('div');
  div.className = 'turn ai';
  return div;
}

function makeThoughtNode(text) {
  const t = document.createElement('span');
  t.className = 'thought';
  t.textContent = text;
  return t;
}

function makeSaidNode(text) {
  const s = document.createElement('span');
  s.className = 'said';
  s.textContent = text || '';
  return s;
}

function renderUserTurn(content) {
  const div = document.createElement('div');
  div.className = 'turn user';
  const body = document.createElement('span');
  body.textContent = content;
  div.appendChild(body);
  transcript.appendChild(div);
  scrollMaybe();
}

function renderEphemeral(text) {
  const div = document.createElement('div');
  div.className = 'ephemeral';
  div.textContent = text;
  transcript.appendChild(div);
  scrollMaybe();
}

function renderHistoricalAiPair(thoughtText, saidText) {
  const div = makeAiTurn();
  if (thoughtText) div.appendChild(makeThoughtNode(thoughtText));
  div.appendChild(makeSaidNode(saidText || ''));
  transcript.appendChild(div);
}

// THINKING INDICATOR — she generates a (sometimes long) private <think> before any <say>
// streams, so without this the chat looks frozen for several seconds, then text appears (or,
// if the think ran long and truncated, "…"). Show pulsing dots the moment a message is sent;
// clear them on the first streamed token, on complete, or on error.
let thinkingNode = null;
let liveSayBuffer = '';

// RUN STATUS (harness transplant, Lucas 2026-07-29): a running reply shows its elapsed time, and —
// once say-tokens stream — an approximate token count (chars/4; the think phase is invisible to
// this renderer, so the count starts when the say does). The stat rides the thinking dots, moves
// onto the streaming turn with the first token, and the finished turn keeps a muted stamp.
let runStartTs = 0, runStatNode = null, runStatTimer = null;
function _runStatText() {
  const secs = Math.max(0, (Date.now() - runStartTs) / 1000);
  const t = liveSayBuffer ? ` · ~${Math.max(1, Math.round(liveSayBuffer.length / 4))} tok` : '';
  return `${secs < 10 ? secs.toFixed(1) : Math.round(secs)}s${t}`;
}
function startRunStat() {
  runStartTs = Date.now();
  if (!runStatNode) { runStatNode = document.createElement('span'); runStatNode.className = 'runstat'; }
  runStatNode.textContent = '0.0s';
  if (runStatTimer) clearInterval(runStatTimer);
  runStatTimer = setInterval(() => { if (runStatNode) runStatNode.textContent = _runStatText(); }, 250);
}
function stopRunStat() {
  if (runStatTimer) { clearInterval(runStatTimer); runStatTimer = null; }
  if (runStatNode) runStatNode.remove();
}

function showThinking() {
  if (thinkingNode) return;
  thinkingNode = document.createElement('div');
  thinkingNode.className = 'thinking';
  thinkingNode.setAttribute('aria-label', 'Zoe is thinking');
  for (let i = 0; i < 3; i++) {
    const d = document.createElement('span');
    d.className = 'dot';
    thinkingNode.appendChild(d);
  }
  startRunStat();
  thinkingNode.appendChild(runStatNode);
  transcript.appendChild(thinkingNode);
  scrollMaybe();
}
function hideThinking() {
  if (thinkingNode) { thinkingNode.remove(); thinkingNode = null; }
}

function cleanLiveSay(s) {
  return (s || '')
    .replace(/<\/?think>/gi, '')
    .replace(/<\/?say>/gi, '')
    .replace(/<navigate>[^<]*<\/navigate>/gi, '')
    .replace(/<wonder>[\s\S]*?<\/wonder>/gi, '')
    .replace(/<\|[a-z_]+\|>/gi, '')   // tokenizer special tokens like <|system|>, <|user|>
    .replace(/<\|[a-z_]+/gi, '')       // unfinished tokenizer tokens still streaming
    // Her voice marks (cut 9): <tone warm/> <laugh/> <sigh/> <breath/> <chuckle/> <hmm/> are heard, never shown —
    // whole tags go, and an unfinished one still streaming goes too.
    .replace(/<tone\s+[a-z]+\s*\/?>/gi, '').replace(/<(breath|sigh|laugh|chuckle|hmm|pause)\s*\/?>/gi, '')
    .replace(/<tone\b[^>]*$/i, '').replace(/<(breath|sigh|laugh|chuckle|hmm|pause)[^>]*$/i, '')
    // Markdown-italic markers: drop the ASTERISKS, keep the WORDS. The display never destroys content
    // (the old blanket strip ate "*Almost Famous*" → "My favorite movie is because…"). Whether stage
    // directions appear at all is the PROMPT's job, per mode (normal suppresses them; fantasy wants
    // them) — not the renderer's to guess and delete.
    .replace(/\*([^*\n]{1,200})\*/g, '$1')
    .replace(/[ \t]+/g, ' ');
}

window.sq.onSayToken((token, stream) => {
  // STREAM DISCRIMINATOR (2026-07-30, the reply-delivery-path root fix): every emitter now stamps
  // its tokens — 'reply' (the prompted turn + its tool-followups) vs the autonomous lanes
  // ('heartbeat' | 'continuity' | 'auto'). A stamped token routes by FACT; the latch heuristics
  // below survive ONLY for legacy/unstamped emitters, where they can no longer misfile a reply.
  if (stream && stream !== 'reply') {
    sheepBufs[stream] = (sheepBufs[stream] || '') + token;
    return;
  }
  if (stream === 'reply') {
    if (!currentAiTurnDiv) {
      hideThinking();
      currentAiTurnDiv = makeAiTurn();
      currentAiSaidNode = makeSaidNode('');
      currentAiTurnDiv.appendChild(currentAiSaidNode);
      if (runStatNode && runStatTimer) currentAiTurnDiv.appendChild(runStatNode);
      transcript.appendChild(currentAiTurnDiv);
      liveSayBuffer = '';
    }
    liveSayBuffer += token;
    currentAiSaidNode.textContent = cleanLiveSay(liveSayBuffer);
    scrollMaybe();
    return;
  }
  // ⭐ A REPLY LUCAS IS WAITING FOR ALWAYS WINS.
  //
  // `unpromptedActive` is a LATCH: set on the first token of an autonomous stream and cleared only by
  // that stream's `complete`. If a completion never arrives — a suppressed heartbeat say, a silenced
  // monologue, an idle tick that dies mid-stream — the latch stays set FOREVER, and from then on every
  // prompted reply falls into the buffer below and is filed in the sheep panel while the chat sits on
  // "…". Live 2026-07-20: Lucas asked about burger sides, the answer was generated and stored
  // correctly (unprompted=0 in the DB) and rendered into the unprompted rail. Nothing self-heals it
  // short of a reload.
  //
  // So a pending prompted reply CLEARS the latch rather than yielding to it. The worst case if the
  // latch was legitimately set is that one autonomous utterance loses its buffer; the worst case the
  // other way is that Lucas never sees an answer again this session.
  if (promptedReplyPending && !currentAiTurnDiv && unpromptedActive) {
    console.warn('[chat] stale unpromptedActive latch cleared — this stream is a prompted reply');
    unpromptedActive = false;
    unpromptedBuffer = '';
  }
  // Decide destination on the first token of a stream. A user-prompted reply streams into
  // the dialogue transcript; an autonomous (unprompted) utterance is buffered for the sheep
  // panel and never touches the transcript.
  if (!currentAiTurnDiv && !unpromptedActive) {
    if (promptedReplyPending) {
      hideThinking();
      currentAiTurnDiv = makeAiTurn();
      currentAiSaidNode = makeSaidNode('');
      currentAiTurnDiv.appendChild(currentAiSaidNode);
      // The run stat survives the dots (hideThinking removed its parent) — ride the streaming turn.
      if (runStatNode && runStatTimer) currentAiTurnDiv.appendChild(runStatNode);
      transcript.appendChild(currentAiTurnDiv);
      liveSayBuffer = '';
    } else {
      unpromptedActive = true;
      unpromptedBuffer = '';
    }
  }
  if (unpromptedActive) { unpromptedBuffer += token; return; }
  liveSayBuffer += token;
  currentAiSaidNode.textContent = cleanLiveSay(liveSayBuffer);
  scrollMaybe();
});

window.sq.onComplete((info) => {
  // Discriminated autonomous completion → flush ITS stream buffer to the sheep rail; the
  // prompted-reply state is never touched (this can no longer shunt or reset a pending reply).
  if (info && info.s && info.s !== 'reply') {
    const text = (typeof info.say === 'string' && info.say.trim())
      ? info.say.trim() : cleanLiveSay(sheepBufs[info.s] || '').trim();
    if (text && !info.silent) {
      appendSheep({ ts: Date.now(), content: text, type: 'utterance' });
      // HALF-DUPLEX (audit S23): never SPEAK an unprompted say over his in-progress utterance —
      // the text is on the sheep panel either way; speaking it would abort his live mic capture.
      try { if (window.sq.speak && !window.__micCapturing) window.sq.speak(text); } catch (e) {}
    }
    sheepBufs[info.s] = '';
    return;
  }
  // Autonomous utterance → sheep panel, never the dialogue transcript. Leave the user's
  // input state untouched (an unprompted completion isn't a reply to anything they sent).
  // GATE on !currentAiTurnDiv, NOT on !promptedReplyPending. A racing idle completion (heartbeat/
  // continuity) — even one that chose SILENCE — used to arrive between the user's send() and the
  // real reply's first token, i.e. while promptedReplyPending was still true. The old `!promptedReplyPending`
  // clause made this branch false, so it FELL THROUGH and reset promptedReplyPending/sending/input;
  // the real reply then streamed as "unprompted" straight into the sheep rail (the shunt Lucas saw —
  // his "38 Parishes" answer landed under UNPROMPTED). The one unprompted completion that IS the reply
  // is a tool-result followup, and by the time it completes it ALWAYS has currentAiTurnDiv set (its
  // answer streamed into the transcript turn) — so `!currentAiTurnDiv` distinguishes it cleanly and it
  // still falls through to finish. A racing idle completion has currentAiTurnDiv === null → handled here,
  // and promptedReplyPending is preserved for the real reply.
  if (!(info && info.s === 'reply') && !currentAiTurnDiv && (unpromptedActive || (info && (info.unprompted || info.silent)))) {
    const text = (info && typeof info.say === 'string' && info.say.trim())
      ? info.say.trim() : cleanLiveSay(unpromptedBuffer).trim();
    if (text) {
      appendSheep({ ts: Date.now(), content: text, type: 'utterance' });
      // HALF-DUPLEX (audit S23): hold the SPOKEN unprompted say while he is mid-utterance (text stays on the panel)
      try { if (window.sq.speak && !(info && info.silent) && !window.__micCapturing) window.sq.speak(text); } catch (e) {}
    }
    unpromptedActive = false;
    unpromptedBuffer = '';
    return;
  }
  hideThinking();
  const turnDiv = currentAiTurnDiv;
  const saidNode = currentAiSaidNode;
  // Freeze the run stat into a permanent muted stamp on the finished turn (only if tokens streamed —
  // a silent completion leaves no stamp), then clear the live counter.
  if (turnDiv && liveSayBuffer && runStartTs) {
    const stamp = document.createElement('div');
    stamp.className = 'turnstat';
    stamp.textContent = _runStatText();
    turnDiv.appendChild(stamp);
  }
  stopRunStat();
  if (turnDiv && saidNode) {
    // If the backend rewrote the say (voice guard de-disclaimed it), the corrected
    // text rides the complete payload — use it to replace what streamed. Otherwise
    // render the accumulated live buffer as before.
    if (info && typeof info.say === 'string' && info.say.trim()) {
      saidNode.textContent = info.say.trim();
    } else {
      saidNode.textContent = cleanLiveSay(liveSayBuffer).trim();
    }
  }
  // HONEST CUT (the clipped-table class): a stream that genuinely ended mid-generation says so
  // on screen instead of silently stopping — a cut you can SEE is a cut you can re-ask about.
  // ⚠ Keys on `cutOff`, NOT `truncated`. truncated=1 only means the stream ended without a closing
  // </say>, which a complete cloud reply does routinely — measured in main.js, 3 of 18 flagged and
  // none actually cut. Stamping the raw flag announced finished answers as broken, which is what
  // Lucas was seeing over and over. cutOff is the backend's real verdict (ollama.sayLooksCutOff:
  // truncated AND short-or-unterminated), the same test that decides whether to regenerate.
  // Falls back to `truncated` only if an older payload carries no cutOff field.
  const _cut = info && (typeof info.cutOff === 'boolean' ? info.cutOff : !!info.truncated);
  if (turnDiv && _cut) {
    const cut = document.createElement('div');
    cut.className = 'turnstat';
    cut.textContent = '— that reply was cut off mid-stream —';
    turnDiv.appendChild(cut);
  }
  routeThoughtToSheep();   // her <think> is filed to the sheep panel, not the transcript
  currentAiTurnDiv = null;
  currentAiSaidNode = null;
  liveSayBuffer = '';
  promptedReplyPending = false;
  sending = false;
  input.disabled = false;
  input.focus();
});

// Her conversational <think> is private cognition, not dialogue — so after a reply
// completes we file it into the sheep panel (the one-way mirror) rather than the
// transcript. Strict adjacency (thought.id === said.id - 1) guarantees it's THIS turn's
// thought; the dedup guard stops a double-file if onComplete fires more than once.
async function routeThoughtToSheep() {
  try {
    const recent = await window.sq.getRecentHistory();
    let lastSaid = null;
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i].speaker === 'ai_said') { lastSaid = recent[i]; break; }
    }
    if (!lastSaid) return;
    let pairedThought = null;
    for (let i = 0; i < recent.length; i++) {
      if (recent[i].id === lastSaid.id - 1 && recent[i].speaker === 'ai_thought') {
        pairedThought = recent[i];
        break;
      }
    }
    if (pairedThought && pairedThought.content && pairedThought.id !== lastSheepThoughtId) {
      lastSheepThoughtId = pairedThought.id;
      appendSheep({ ts: pairedThought.ts || Date.now(), content: pairedThought.content, type: 'thought' });
    }
  } catch (err) {
    console.error('thought→sheep route failed:', err);
  }
}

window.sq.onError((err) => {
  hideThinking();
  stopRunStat();
  renderEphemeral(`— ${err} —`);
  currentAiTurnDiv = null;
  currentAiSaidNode = null;
  sending = false;
  input.disabled = false;
  input.focus();
});

// Busy-lane placeholder: she's mid-thought, so she drops a quick "hang on" in her
// own voice while the real reply generates. Rendered as a standalone AI line so it
// doesn't collide with the streaming turn (which starts its own div on first token).
if (window.sq.onBusy) {
  window.sq.onBusy((text) => {
    const div = makeAiTurn();
    div.appendChild(makeSaidNode(text));
    transcript.appendChild(div);
    scrollMaybe();
  });
}

// Image she CREATED (vision out) → show it inline as its own AI bubble.
if (window.sq.onImage) {
  window.sq.onImage((info) => {
    try {
      const { dataUrl, path, prompt } = info || {};
      const src = dataUrl || (path ? 'file://' + path : '');
      if (!src) return;
      const div = makeAiTurn();
      const img = document.createElement('img');
      img.className = 'gen-image';
      img.src = src;
      img.alt = prompt || 'generated image';
      img.style.maxWidth = '100%';
      img.style.borderRadius = '8px';
      div.appendChild(img);
      transcript.appendChild(div);
      scrollMaybe();
    } catch (err) { console.error('image render failed:', err); }
  });
}

window.sq.onReflectionFired(() => {
  renderEphemeral('— time passed —');
});

window.sq.onMonologueTick((info) => {
  appendSheep(info);
});

if (window.sq.onInboundArrived) {
  window.sq.onInboundArrived((ev) => {
    appendSheep({
      ts: Date.now(),
      content: `${ev.speaker || 'bot'}: ${(ev.text || '').slice(0, 280)}`,
      type: 'inbound',
      query: ev.url
    });
  });
}
if (window.sq.onInboundTimeout) {
  window.sq.onInboundTimeout((ev) => {
    appendSheep({
      ts: Date.now(),
      content: `(no reply within 45s on ${ev.url || 'tab'})`,
      type: 'inbound-timeout'
    });
  });
}

function appendSheep({ ts, content, type, query }) {
  const div = document.createElement('div');
  let cls = 'sheep';
  if (type === 'reading') cls += ' reading';
  if (type === 'self_q') cls += ' self-q';
  if (type === 'self_a') cls += ' self-a';
  if (type === 'thought') cls += ' thought';
  if (type === 'utterance') cls += ' utterance';
  if (type === 'inbound') cls += ' inbound';
  if (type === 'inbound-timeout') cls += ' inbound-timeout';
  div.className = cls;
  const timeNode = document.createElement('span');
  timeNode.className = 'sheep-time';
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  let timeLabel = `${hh}:${mm}:${ss}`;
  if (type === 'reading' && query) timeLabel += `  ↗ ${query}`;
  else if (type === 'self_q') timeLabel += '  ↻ subconscious';
  else if (type === 'self_a') timeLabel += '  ↻ articulate self';
  else if (type === 'thought') timeLabel += '  · thinking';
  else if (type === 'utterance') timeLabel += '  💬 unprompted';
  else if (type === 'inbound') timeLabel += '  ⇐ incoming';
  else if (type === 'inbound-timeout') timeLabel += '  ⌛ timeout';
  timeNode.textContent = timeLabel;
  div.appendChild(timeNode);
  const body = document.createElement('span');
  body.textContent = content;
  div.appendChild(body);
  sheepStream.appendChild(div);
  while (sheepStream.children.length > 200) {
    sheepStream.removeChild(sheepStream.firstChild);
  }
  sheepStream.scrollTop = sheepStream.scrollHeight;
}

async function send() {
  if (sending) return;
  const text = input.value.trim();
  if (!text && pendingAttachments.length === 0) return;
  sending = true;
  input.value = '';
  autosizeInput();
  input.disabled = true;
  const displayText = text + (pendingAttachments.length > 0
    ? `\n[attached: ${pendingAttachments.map(a => a.name).join(', ')}]`
    : '');
  renderUserTurn(displayText);
  // SEAL the previous live bubble (Phase 0, doc-plan #7): if a stale async stream was mid-bubble
  // when this message was sent, the main process mutes it (reply_lane) — but without this seal the
  // NEW reply's first token would append into that half-finished div. A fresh turn always opens a
  // fresh bubble; whatever half-streamed stays sealed as-is (its full say arrives via the demoted
  // completion on the sheep rail, and the DB row is intact).
  if (currentAiTurnDiv) { console.warn('[chat] sealing a half-streamed bubble — a new prompted turn starts fresh'); }
  currentAiTurnDiv = null;
  currentAiSaidNode = null;
  liveSayBuffer = '';
  promptedReplyPending = true;   // the next streamed reply belongs in the transcript
  showThinking();
  const attachmentsToSend = pendingAttachments.slice();
  pendingAttachments.length = 0;
  renderAttachments();
  try {
    await window.sq.sendMessage(text || '(see attachments)', attachmentsToSend);
  } catch (err) {
    renderEphemeral(`— ${err.message || err} —`);
    stopRunStat();
    sending = false;
    input.disabled = false;
    input.focus();
  }
}

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

// --- Push-to-talk voice input (two-way, Slice 1) ---
// Tap the mic → record → tap again → transcribe (local CPU faster-whisper) → the text is dropped into
// the composer and sent through the EXACT existing chat path (send()). No second brain path; the reply is
// spoken by the same speakThroughCompanion route as any typed turn. Endpointing here is the tap itself
// (VAD/barge-in/wakeword are later slices). Fail-soft: any error drops back to the idle mic state.
const micBtn = document.getElementById('mic-btn');
if (micBtn && !(window.sq && window.sq.sttTranscribe)) {
  micBtn.style.display = 'none';   // preload too old to expose STT → hide the control rather than dangle it
} else if (micBtn) {
  const MIC_IDLE = '🎤 speak';
  let micStream = null, micRecorder = null, micChunks = [], micRecording = false;
  const micReset = () => { micBtn.textContent = MIC_IDLE; micBtn.classList.remove('recording'); micBtn.style.color = ''; micBtn.disabled = false; };

  async function micStart() {
    if (micRecording || sending) return;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) { renderEphemeral('— microphone access denied —'); return; }
    micChunks = [];
    try {
      micRecorder = new MediaRecorder(micStream);
    } catch (e) { renderEphemeral('— audio capture unavailable —'); try { micStream.getTracks().forEach((t) => t.stop()); } catch {} return; }
    micRecorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) micChunks.push(ev.data); };
    micRecorder.onstop = micOnStop;
    micRecorder.start();
    micRecording = true;
    micBtn.textContent = '● listening… (tap to send)';
    micBtn.classList.add('recording');
    micBtn.style.color = '#e5484d';
  }

  function micStop() {
    if (!micRecording || !micRecorder) return;
    micRecording = false;
    micBtn.textContent = '… transcribing';
    micBtn.disabled = true;
    try { micRecorder.stop(); } catch {}
  }

  async function micOnStop() {
    try { if (micStream) micStream.getTracks().forEach((t) => t.stop()); } catch {}
    const blob = new Blob(micChunks, { type: (micRecorder && micRecorder.mimeType) || 'audio/webm' });
    micChunks = [];
    if (!blob.size) { micReset(); return; }
    try {
      const buf = await blob.arrayBuffer();
      const res = await window.sq.sttTranscribe(buf);
      if (res && res.ok && res.text && res.text.trim()) {
        input.value = res.text.trim();
        autosizeInput();
        micReset();
        send();                                   // one brain path — same as a typed message
      } else if (res && res.ok) {
        micReset();
        renderEphemeral('— heard nothing —');
      } else {
        micReset();
        renderEphemeral(`— transcription failed: ${(res && res.error) || 'unknown'} —`);
      }
    } catch (e) {
      micReset();
      renderEphemeral(`— voice input error: ${e.message || e} —`);
    }
  }

  micBtn.addEventListener('click', () => (micRecording ? micStop() : micStart()));
}

// --- Her voice plays in THIS renderer (two-way, Slice 3) ---
// main routes every spoken wav here so Chromium's echo cancellation can subtract it from the mic (enabling
// barge-in) and so a sentence can be cancelled instantly. Works for typed replies too, not just conversation.
let curVoiceAudio = null, curVoiceId = null;
if (window.sq && window.sq.onVoicePlay) {
  window.sq.onVoicePlay(({ id, url }) => {
    stopCurrentVoice(false);   // replace any lingering clip without acking it (queue is serial; belt-and-braces)
    let a;
    try { a = new Audio(url); } catch (e) { try { window.sq.voicePlayDone(id, false); } catch {} return; }
    curVoiceAudio = a; curVoiceId = id;
    const done = (played) => { if (curVoiceId === id) curVoiceId = null; if (curVoiceAudio === a) curVoiceAudio = null; try { window.sq.voicePlayDone(id, played); } catch {} };
    a.addEventListener('ended', () => done(true));
    a.addEventListener('error', () => done(false));
    a.play().then(() => { console.log('[voice] playing clip'); }).catch((e) => { console.warn('[voice] playback blocked/failed (autoplay?):', e && e.message); done(false); });
  });
}
// Stop the clip she's currently speaking. ack=true tells main the clip is "done" (it DID play, just cut
// short by barge) so the serial queue advances — a paused element won't fire 'ended' on its own.
function stopCurrentVoice(ack = true) {
  try { if (curVoiceAudio) curVoiceAudio.pause(); } catch {}
  const id = curVoiceId; curVoiceAudio = null; curVoiceId = null;
  if (ack && id != null) { try { window.sq.voicePlayDone(id, true); } catch {} }
}

// --- Full hands-free conversation mode (two-way, Slice 2 + Slice 3 barge-in) ---
// Toggle on → the mic listens continuously; an RMS energy gate detects utterance start/end, transcribes,
// and fires the SAME send() a typed message uses. While she is THINKING or SPEAKING the ear is suspended
// (half-duplex — no self-hearing; barge-in is a later slice), driven by the main-process `voice:speaking`
// signal. A silence timeout auto-exits. Reuses the Slice-1 STT path; adds no new brain path.
const convoBtn = document.getElementById('convo-btn');
if (convoBtn && !(window.sq && window.sq.sttTranscribe && window.sq.onVoiceSpeaking)) {
  convoBtn.style.display = 'none';   // preload too old → hide rather than dangle
  const _eb = document.getElementById('enroll-btn'); if (_eb) _eb.style.display = 'none';
} else if (convoBtn) {
  const CONVO_IDLE = '🎙️ conversation';
  const RMS_START = 0.020;      // speech onset — tuned to AGC-ON levels (speech ~0.07-0.13, AGC noise floor ~0.02)
  const RMS_END = 0.012;        // sustained below this = end of utterance
  const START_MS = 150;         // sustained energy before it counts as speech (debounce blips)
  const TAIL_MS = 1200;         // sustained silence that ends an utterance (raised so mid-thought pauses don't cut you off)
  const TIMEOUT_MS = 180000;    // auto-exit after 3 min with no user speech
  const RESUME_GUARD_MS = 150;  // settle after she stops before reopening the ear (short = conversationally snappy)
  const AWAIT_MAX_MS = 15000;   // safety: reopen the ear even if a reply produced no speech
  const PREROLL_MS = 400;       // rolling pre-roll prepended on speech-start so the utterance ONSET isn't clipped
  const BARGE_RMS = 0.055;      // energy on the AEC-cleaned mic that counts as the USER interrupting her (tunable)
  const BARGE_MS = 140;         // sustained interrupt energy before we cut her off
  const MIN_SPEECH_RMS = 0.030; // a capture must PEAK above this to be real speech — else it's noise and is
                                // discarded before STT (tuned to AGC-ON: noise floor ~0.02, speech ~0.07-0.13)

  let alwaysOn = true;          // ALWAYS-ON: mic auto-starts on boot and never idle-times-out (persisted pref)
  let bargeEnabled = true;      // S3 full-duplex barge-in; falls back to half-duplex if AEC can't suppress her voice
  let convoOn = false, convoStream = null, ac = null, analyser = null, tdBuf = null, loopTimer = null;
  let sp = null, pcmRate = 48000, ringBuf = [], uttBuf = [], capturing = false;   // PCM pre-roll capture (no MediaRecorder)
  let voiceStart = 0, silenceStart = 0, lastUserSpeech = 0;
  let sheSpeaking = false, resumeAt = 0, awaitingReply = false, awaitTimer = null;
  let bargeStart = 0, echoPeak = 0, bargeCapture = false;   // barge-in detection + AEC residual-echo instrumentation
  let winMax = 0, winLogAt = 0, captureMax = 0, captureStartTs = 0;   // mic-pickup instrumentation

  // Speaker-ID gate: teach her the operator's voice so the always-on ear responds ONLY to him — a video he's
  // watching, another person, an announcement is transcribed but DROPPED (never reaches her brain). Enrollment
  // reuses the exact VAD capture path, so enrolled + runtime audio share acoustic conditioning.
  const ENROLL_NEED = 5;
  let enrolling = false, enrollGot = 0, spkStatus = { enrolled: false, gate: true };
  const enrollBtn = document.getElementById('enroll-btn');
  const enrollLabel = () => `🎓 learning your voice ${enrollGot}/${ENROLL_NEED} — keep talking`;
  async function refreshSpeakerStatus() {
    try { const s = await window.sq.speakerStatus(); if (s) spkStatus = s; } catch {}
    if (enrollBtn && !enrolling) enrollBtn.textContent = spkStatus.enrolled ? '🎓 re-learn voice' : '🎓 learn my voice';
    return spkStatus;
  }

  window.sq.onVoiceSpeaking((info) => {
    if (!convoOn) return;
    if (info && info.on) { sheSpeaking = true; if (capturing && !bargeCapture) abortCapture(); }
    else { sheSpeaking = false; awaitingReply = false; clearTimeout(awaitTimer); if (!capturing && !bargeCapture) resumeAt = Date.now() + RESUME_GUARD_MS; }
  });

  const setLabel = (s) => { if (convoBtn.textContent !== s) convoBtn.textContent = s; };

  async function convoStart() {
    if (convoOn) return;
    try {
      // autoGainControl ON: this mic is quiet — AGC boosts speech to ~0.07–0.13 (a strong signal Whisper
      // transcribes cleanly). AGC-off left speech at ~0.014 and needed peak-normalize, which mangled it.
      convoStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) { renderEphemeral('— microphone access denied —'); return; }
    try {
      ac = new (window.AudioContext || window.webkitAudioContext)();
      try { ac.resume(); } catch {}   // must be running for the ScriptProcessor to fire (autoplay policy can start it suspended)
      pcmRate = ac.sampleRate || 48000;
      const src = ac.createMediaStreamSource(convoStream);
      analyser = ac.createAnalyser(); analyser.fftSize = 1024;
      tdBuf = new Float32Array(analyser.fftSize);
      src.connect(analyser);
      // Raw-PCM tap for a rolling PRE-ROLL buffer: we always hold the last ~PREROLL_MS so the utterance
      // onset (before VAD confirms speech) isn't lost. Routed through a zero-gain node so the mic never
      // feeds back to the speakers.
      ringBuf = []; uttBuf = [];
      sp = ac.createScriptProcessor(4096, 1, 1);
      const maxFrames = Math.max(1, Math.ceil((PREROLL_MS / 1000) * pcmRate / 4096));
      sp.onaudioprocess = (e) => {
        const frame = new Float32Array(e.inputBuffer.getChannelData(0));   // copy — the input buffer is reused
        // PRE-ROLL stays clean of HER voice (2026-08-15 deep-dive V6): the ring used to fill
        // unconditionally, so a capture starting right after she spoke seeded its pre-roll with her
        // own speech tail (AEC residual 0.26 » 0.055 threshold) — dragging genuine speaker-gate
        // scores toward the cut and minting exactly the quiet near-miss rejects V5 now counts.
        // A barge-in capture is unaffected: uttBuf accumulates via `capturing` regardless.
        if (!sheSpeaking) {
          ringBuf.push(frame);
          while (ringBuf.length > maxFrames) ringBuf.shift();
        }
        if (capturing) uttBuf.push(frame);
      };
      const zero = ac.createGain(); zero.gain.value = 0;
      src.connect(sp); sp.connect(zero); zero.connect(ac.destination);
    } catch (e) { renderEphemeral('— audio setup failed —'); try { convoStream.getTracks().forEach((t) => t.stop()); } catch {} return; }
    convoOn = true; lastUserSpeech = Date.now();
    if (micBtn) micBtn.disabled = true;   // one capture owner
    convoBtn.classList.add('recording'); convoBtn.style.color = '#e5484d';
    setLabel('🎙️ listening…');
    loop();
  }

  function convoStop() {
    convoOn = false;
    if (loopTimer) { clearTimeout(loopTimer); loopTimer = null; }
    clearTimeout(awaitTimer); awaitingReply = false;
    abortCapture();
    try { if (sp) { sp.onaudioprocess = null; sp.disconnect(); } } catch {}
    try { if (convoStream) convoStream.getTracks().forEach((t) => t.stop()); } catch {}
    try { if (ac) ac.close(); } catch {}
    convoStream = null; ac = null; analyser = null; sp = null; ringBuf = []; uttBuf = [];
    if (micBtn) micBtn.disabled = false;
    convoBtn.classList.remove('recording'); convoBtn.style.color = '';
    setLabel(CONVO_IDLE);
  }

  function abortCapture() {
    capturing = false; uttBuf = []; bargeCapture = false;
    try { window.__micCapturing = false; } catch {}   // audit S23: he is no longer mid-utterance
  }

  function rmsLevel() {
    analyser.getFloatTimeDomainData(tdBuf);
    let s = 0; for (let i = 0; i < tdBuf.length; i++) s += tdBuf[i] * tdBuf[i];
    return Math.sqrt(s / tdBuf.length);
  }

  // pure: Float32 PCM → a 16-bit mono WAV Blob (the sidecar's ffmpeg resamples to 16k). Clean container —
  // avoids the headerless-webm-chunk trap entirely.
  function encodeWav(pcm, rate) {
    const n = pcm.length, buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
    let p = 0; const s = (t) => { for (let i = 0; i < t.length; i++) dv.setUint8(p++, t.charCodeAt(i)); };
    s('RIFF'); dv.setUint32(p, 36 + n * 2, true); p += 4; s('WAVE'); s('fmt ');
    dv.setUint32(p, 16, true); p += 4; dv.setUint16(p, 1, true); p += 2; dv.setUint16(p, 1, true); p += 2;
    dv.setUint32(p, rate, true); p += 4; dv.setUint32(p, rate * 2, true); p += 4;
    dv.setUint16(p, 2, true); p += 2; dv.setUint16(p, 16, true); p += 2; s('data'); dv.setUint32(p, n * 2, true); p += 4;
    for (let i = 0; i < n; i++) { let v = Math.max(-1, Math.min(1, pcm[i])); dv.setInt16(p, v < 0 ? v * 0x8000 : v * 0x7FFF, true); p += 2; }
    return new Blob([buf], { type: 'audio/wav' });
  }

  function startCapture() {
    uttBuf = ringBuf.slice();   // PRE-ROLL: seed with the last ~PREROLL_MS so the onset isn't clipped
    capturing = true; captureMax = 0; captureStartTs = Date.now();
    try { window.__micCapturing = true; } catch {}   // audit S23: he is MID-UTTERANCE — an unprompted say must not talk over him
    console.log(`[voice] capture start (+${uttBuf.length}-frame preroll)`);
    setLabel('● you\'re talking');
  }

  function endCapture() {
    if (!capturing) return;
    capturing = false;
    try { window.__micCapturing = false; } catch {}   // audit S23: utterance done — the floor is free
    console.log(`[voice] capture end peak=${captureMax.toFixed(4)} ${Date.now() - captureStartTs}ms`);
    setLabel('… transcribing');
    const frames = uttBuf; uttBuf = [];
    onCaptureStop(frames);
  }

  async function onCaptureStop(frames) {
    bargeCapture = false;   // capture ended → normal gating resumes
    const idleLabel = () => (enrolling ? enrollLabel() : '🎙️ listening…');
    if (!frames || !frames.length || !convoOn) { if (convoOn) setLabel(idleLabel()); return; }
    if (captureMax < MIN_SPEECH_RMS) {   // noise, not real speech → don't transcribe (no hallucinated turns)
      console.log(`[voice] discard capture (peak ${captureMax.toFixed(4)} < speech floor ${MIN_SPEECH_RMS})`);
      if (convoOn) setLabel(idleLabel()); return;
    }
    let total = 0; for (const f of frames) total += f.length;
    const pcm = new Float32Array(total); let off = 0; for (const f of frames) { pcm.set(f, off); off += f.length; }
    const blob = encodeWav(pcm, pcmRate);
    const ab = await blob.arrayBuffer();

    // ENROLLMENT MODE: this utterance is a VOICE SAMPLE, not a turn — feed it to the voiceprint, not the brain.
    if (enrolling) {
      try {
        const er = await window.sq.speakerEnroll(ab);
        if (er && er.ok) {
          enrollGot = er.count;
          console.log(`[voice] enroll sample ${enrollGot}/${ENROLL_NEED} (dur=${er.dur}s)`);
          if (enrollGot >= ENROLL_NEED) return void finishEnroll();
          setLabel(enrollLabel());
        } else {
          console.log('[voice] enroll sample rejected:', er && er.error);
          setLabel(`🎓 say a full sentence… ${enrollGot}/${ENROLL_NEED}`);
        }
      } catch (e) { console.log('[voice] enroll error:', e && e.message); }
      return;   // stay in the enrollment loop; the mic keeps capturing samples
    }

    // NORMAL TURN: transcribe + SPEAKER-GATE (+ the hands-free ADDRESSED gate, main-side).
    try {
      const res = await window.sq.sttTranscribe(ab, { handsFree: true });
      const sp2 = res && res.speaker;
      const spLog = sp2 ? `spk=${sp2.match ? 'MATCH' : 'REJECT'} score=${sp2.score} thr=${sp2.threshold}${sp2.enrolled ? '' : ' unenrolled'}${sp2.failOpen ? ' FAILOPEN' : ''}` : 'spk=n/a';
      console.log(`[voice] STT ${(blob.size / 1024).toFixed(0)}KB dur=${res && res.dur}s peak=${res && res.peak} ${spLog} → ${res && res.ok ? JSON.stringify((res.text || '').slice(0, 60)) : 'FAIL ' + (res && res.error)}`);
      if (res && res.ok && res.text && res.text.trim() && convoOn) {
        // SPEAKER GATE: only the enrolled operator's voice becomes a turn. A video, another person, or an
        // announcement transcribes but is DROPPED here (logged, never sent to her brain). Pass-through until
        // enrolled (spk.match defaults true), so the app still works before he teaches her his voice.
        if (sp2 && sp2.match === false) {
          console.log(`[voice] IGNORED — not the operator (score ${sp2.score} < ${sp2.threshold}): ${JSON.stringify((res.text || '').slice(0, 80))}`);
          if (convoOn && !awaitingReply) setLabel('🎙️ listening…');
          return;
        }
        // ADDRESSED GATE (campaign §22): his voice, but not talking TO HER (dictation / nearby
        // speech) — main already shelved it as room awareness; no user turn is minted.
        if (res.addressed && res.addressed.turn === false) {
          console.log(`[voice] IGNORED — not addressed to her (${res.addressed.reason}): ${JSON.stringify((res.text || '').slice(0, 80))}`);
          if (convoOn && !awaitingReply) setLabel('🎙️ listening…');
          return;
        }
        input.value = res.text.trim(); autosizeInput();
        lastUserSpeech = Date.now();
        awaitingReply = true;                       // suspend the ear through THINKING→SPEAKING
        clearTimeout(awaitTimer); awaitTimer = setTimeout(() => { awaitingReply = false; }, AWAIT_MAX_MS);
        send();                                     // one brain path — same as typing
      }
    } catch (e) { /* fail-soft: keep listening */ }
    if (convoOn && !awaitingReply) setLabel('🎙️ listening…');
  }

  // ── enrollment control ────────────────────────────────────────────────────────────────────────────
  function startEnroll() {
    if (!convoOn) convoStart();               // enrollment needs the live mic
    enrolling = true; enrollGot = 0;
    abortCapture();                            // drop any half-captured audio
    renderEphemeral('— learning your voice: say a few natural sentences (5 short samples). After this I\'ll respond only to you and tune out videos, TV, and other people. —');
    setLabel(enrollLabel());
    if (enrollBtn) enrollBtn.textContent = '● learning… (tap to cancel)';
  }
  async function finishEnroll() {
    enrolling = false;
    await refreshSpeakerStatus();
    renderEphemeral('— got it. I know your voice now — I\'ll ignore everything that isn\'t you. —');
    setLabel(convoOn ? '🎙️ listening…' : CONVO_IDLE);
    try { window.sq.speak('Got it — I know your voice now.'); } catch {}
  }
  function cancelEnroll() {
    enrolling = false;
    refreshSpeakerStatus();
    setLabel(convoOn ? '🎙️ listening…' : CONVO_IDLE);
  }

  // The user talked over her → cut her off and capture their interruption.
  function bargeIn() {
    bargeStart = 0;
    console.log(`[voice] barge-in — residual echo peak ${echoPeak.toFixed(4)} vs threshold ${BARGE_RMS}`);
    echoPeak = 0;
    try { window.sq.voiceBarge(); } catch {}   // flush FIRST (bump gen) so no pipelined sentence sneaks out...
    stopCurrentVoice(true);                     // ...THEN stop the current clip + advance main's now-stale queue
    sheSpeaking = false; awaitingReply = false; clearTimeout(awaitTimer); resumeAt = 0;
    bargeCapture = true;
    startCapture();                            // immediately capture the user's interrupting utterance
  }

  function loop() {
    if (!convoOn) return;
    const now = Date.now();
    if (!alwaysOn && now - lastUserSpeech > TIMEOUT_MS) { renderEphemeral('— conversation timed out —'); convoStop(); return; }

    // BARGE-IN window: she's speaking, and her voice plays in THIS renderer so echo-cancellation should keep
    // the mic mostly free of her — a sustained loud input is the USER cutting in. Instrumented (echoPeak) so
    // we can see the residual echo level and judge whether AEC is doing its job on this box.
    if (sheSpeaking && bargeEnabled && !bargeCapture) {
      const lvl = rmsLevel();
      if (lvl > echoPeak) echoPeak = lvl;
      if (lvl > BARGE_RMS) { if (!bargeStart) bargeStart = now; if (now - bargeStart >= BARGE_MS) bargeIn(); }
      else bargeStart = 0;
      setLabel('speaking… (talk to cut in)');
      loopTimer = setTimeout(loop, 40); return;   // poll fast for a snappy interrupt
    }

    // Half-duplex suspend: thinking (no audio to barge), the settle window, or barge disabled while speaking.
    // Never suspend a barge-in capture already in progress.
    if (!bargeCapture && (sheSpeaking || sending || awaitingReply || now < resumeAt)) {
      if (capturing) abortCapture();
      setLabel((sheSpeaking || sending || awaitingReply) ? 'speaking…' : '🎙️ listening…');
      loopTimer = setTimeout(loop, 80); return;
    }
    const level = rmsLevel();
    if (!capturing) {
      // instrumentation: log the peak level seen each ~1.5s while listening, so we can see the user's speech
      // level vs RMS_START and calibrate pickup (the "not picking me up" diagnosis).
      if (level > winMax) winMax = level;
      if (now - winLogAt > 1500) { console.log(`[voice] listening max=${winMax.toFixed(4)} thr=${RMS_START}`); winMax = 0; winLogAt = now; }
      if (level > RMS_START) { if (!voiceStart) voiceStart = now; if (now - voiceStart >= START_MS) { voiceStart = 0; silenceStart = 0; startCapture(); } }
      else { voiceStart = 0; setLabel('🎙️ listening…'); }
    } else {
      if (level > captureMax) captureMax = level;
      if (level < RMS_END) { if (!silenceStart) silenceStart = now; if (now - silenceStart >= TAIL_MS) { silenceStart = 0; endCapture(); } }
      else { silenceStart = 0; }
    }
    loopTimer = setTimeout(loop, 80);
  }

  // The 🎙️ button toggles always-on and PERSISTS the choice, so it survives reboots.
  convoBtn.addEventListener('click', async () => {
    if (convoOn) { convoStop(); alwaysOn = false; try { await window.sq.setMeta('always_on_mic', '0'); } catch {} }
    else { alwaysOn = true; try { await window.sq.setMeta('always_on_mic', '1'); } catch {} convoStart(); }
  });
  // 🎓 learn-my-voice toggles enrollment (start / cancel). Hidden if the preload is too old to expose it.
  if (enrollBtn && !(window.sq && window.sq.speakerEnroll)) {
    enrollBtn.style.display = 'none';
  } else if (enrollBtn) {
    enrollBtn.addEventListener('click', () => { if (enrolling) cancelEnroll(); else startEnroll(); });
  }
  // ALWAYS-ON: auto-start the mic on load unless the operator turned it off (persisted). getUserMedia is
  // auto-granted by the default-session permission handler, so no click is needed to begin listening.
  (async () => {
    try { const pref = await window.sq.getMeta('always_on_mic'); alwaysOn = (pref !== '0'); } catch { alwaysOn = true; }
    // Barge-in defaults OFF: AEC can't cancel her voice on this box (measured residual ~0.26 » 0.055), so a
    // live mic during her speech just self-triggers. Half-duplex (ear suspended while she talks) is the default.
    try { const b = await window.sq.getMeta('barge_in'); bargeEnabled = (b === '1'); } catch { bargeEnabled = false; }
    if (alwaysOn) convoStart();
    // Voice-ID: reflect enrollment state on the button, and nudge ONCE if the gate is armed but she can't yet
    // tell his voice from the room (until enrolled the gate passes everything through — the video bug persists).
    const st = await refreshSpeakerStatus();
    if (alwaysOn && st && st.gate && !st.enrolled) {
      renderEphemeral('— tip: tap "🎓 learn my voice" so I respond only to you and ignore videos, TV, and other people. —');
    }
  })();
}

function showNameCapture() {
  const overlay = document.createElement('div');
  overlay.id = 'name-overlay';

  const q = document.createElement('div');
  q.className = 'question';
  q.textContent = 'What should I call you?';

  const inp = document.createElement('input');
  inp.type = 'text';
  inp.maxLength = 80;
  inp.spellcheck = false;
  inp.autocomplete = 'off';

  inp.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const name = inp.value.trim();
      if (!name) return;
      await window.sq.setMeta('user_name', name);
      overlay.remove();
      input.focus();
    }
  });

  overlay.appendChild(q);
  overlay.appendChild(inp);
  document.body.appendChild(overlay);
  setTimeout(() => inp.focus(), 0);
}

function renderSatWith(thoughtText) {
  const wrapper = document.createElement('div');
  wrapper.className = 'sat-with';
  const label = document.createElement('div');
  label.className = 'sat-with-label';
  label.textContent = '— she sat with this and didn\'t speak —';
  const body = document.createElement('div');
  body.className = 'sat-with-body';
  body.textContent = thoughtText;
  wrapper.appendChild(label);
  wrapper.appendChild(body);
  transcript.appendChild(wrapper);
}

async function loadHistory() {
  // Transcript is dialogue ONLY: user messages + her spoken replies. All thought
  // (ai_thought) is rendered in the sheep panel instead (see loadSheep).
  const turns = await window.sq.getRecentHistory();
  for (const t of turns) {
    if (t.speaker === 'user') renderUserTurn(t.content);
    // Prompted replies only. Unprompted said-turns (heartbeat/continuity/follow-ups) are
    // diverted to the sheep panel, matching the live behavior. ai_thought never shows here.
    else if (t.speaker === 'ai_said' && !t.unprompted) renderHistoricalAiPair(null, t.content);
  }
  transcript.scrollTop = transcript.scrollHeight;
}

async function loadSheep() {
  try {
    // The sheep panel is her full inner stream: idle monologue/readings (from `monologue`)
    // interleaved with her conversational <think> (ai_thought turns), in time order.
    const [monologue, history] = await Promise.all([
      window.sq.getRecentMonologue(40),
      window.sq.getRecentHistory()
    ]);
    const items = [];
    for (const m of monologue) items.push({ ts: m.ts, content: m.content, type: m.type, query: m.query });
    for (const t of history) {
      if (t.speaker === 'ai_thought' && t.content) items.push({ ts: t.ts, content: t.content, type: 'thought' });
      else if (t.speaker === 'ai_said' && t.unprompted && t.content) items.push({ ts: t.ts, content: t.content, type: 'utterance' });
    }
    items.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    for (const it of items) appendSheep(it);
  } catch (err) {
    console.error('sheep load failed:', err);
  }
}

async function openDashboard() {
  dashboardOverlay.classList.remove('hidden');
  dashboardBody.innerHTML = '<div class="dash-empty">Loading…</div>';
  try {
    const m = await window.sq.getDashboardMetrics();
    renderDashboard(m);
  } catch (err) {
    dashboardBody.innerHTML = `<div class="dash-empty">Error: ${escapeHtml(err.message)}</div>`;   // audit F39: the one unescaped sink — error text can quote stored strings
  }
}

function closeDashboard() {
  dashboardOverlay.classList.add('hidden');
}

function pct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

function timeAgo(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const h = Math.floor(diff / 3600000);
  if (h < 1) return `${Math.floor(diff / 60000)}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function renderDashboard(m) {
  const c = m.commitments;
  const s = m.sycophancy;
  const i = m.initiation;
  const t = m.totals;

  const commitmentItems = (c.recent_held && c.recent_held.length > 0)
    ? c.recent_held.map(x =>
        `<div class="dash-commitment">• ${escapeHtml(x.claim)} <span style="color:#4a4a52;font-size:10px;">(${timeAgo(x.first_held_at)})</span></div>`
      ).join('')
    : '<div class="dash-empty">No commitments held yet.</div>';

  dashboardBody.innerHTML = `
    <div class="dash-section">
      <div class="dash-section-title">commitments</div>
      <div class="dash-row"><span class="dash-label">held</span><span class="dash-value">${c.held}</span></div>
      <div class="dash-row"><span class="dash-label">revised</span><span class="dash-value">${c.revised}</span></div>
      <div class="dash-row"><span class="dash-label">abandoned</span><span class="dash-value">${c.abandoned}</span></div>
      <div class="dash-row"><span class="dash-label">total ever</span><span class="dash-value">${c.total}</span></div>
    </div>

    <div class="dash-section">
      <div class="dash-section-title">recent held positions</div>
      ${commitmentItems}
    </div>

    <div class="dash-section">
      <div class="dash-section-title">sycophancy density (last ${s.window_size} responses)</div>
      <div class="dash-row"><span class="dash-label">turns with flagged phrases</span><span class="dash-value">${pct(s.density)}</span></div>
      <div class="dash-row"><span class="dash-label">total hits</span><span class="dash-value">${s.hits}</span></div>
    </div>

    <div class="dash-section">
      <div class="dash-section-title">initiation rate (last ${i.window_size} responses)</div>
      <div class="dash-row"><span class="dash-label">turns where she introduced something</span><span class="dash-value">${pct(i.rate)}</span></div>
      <div class="dash-row"><span class="dash-label">count</span><span class="dash-value">${i.count}</span></div>
    </div>

    <div class="dash-section">
      <div class="dash-section-title">substrate totals</div>
      <div class="dash-row"><span class="dash-label">conversation turns</span><span class="dash-value">${t.turns}</span></div>
      <div class="dash-row"><span class="dash-label">reflections</span><span class="dash-value">${t.reflections}</span></div>
      <div class="dash-row"><span class="dash-label">monologue thoughts</span><span class="dash-value">${t.monologue_thoughts}</span></div>
      <div class="dash-row"><span class="dash-label">readings</span><span class="dash-value">${t.monologue_readings}</span></div>
    </div>
  `;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

if (dashboardToggle) dashboardToggle.addEventListener('click', openDashboard);
if (dashboardClose) dashboardClose.addEventListener('click', closeDashboard);
if (dashboardOverlay) {
  dashboardOverlay.addEventListener('click', (e) => {
    if (e.target === dashboardOverlay) closeDashboard();
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !dashboardOverlay.classList.contains('hidden')) closeDashboard();
});

// ── APPROVAL CARDS (Lucas 09-01: authorization asks are NON-CHAT yes/no permission requests) ────
// Pending needs render as cards with ✓/✗; a click routes to capability_need.decide() in main and
// the bar re-renders from the returned set. Restored on every load via needs:pending, refreshed by
// the needs:approvals push. Fail-soft: any error hides the bar rather than wedging the chat.
const approvalsBar = document.getElementById('approvals-bar');
// Lucas 09-01 QOL: cards expand to the FULL proposal (click the card body — rationale, files,
// stage note, the diff itself), and a ✓'d pen proposal stays on the bar as a live buttonless
// progress card (kind 'pen-run') through the enforce pipeline. Expanded ids survive the bar's
// wholesale innerHTML rebuilds via this Set; running pen cards start expanded so the stage shows.
const _expandedCards = new Set();
const _collapsedCards = new Set();   // a running pen card auto-opens; this remembers his explicit collapse
let _lastApprovalItems = null;
const PEN_RUN_CHIP = { approved: '⚙ queued', applying: '⚙ applying + gating', applied: '✅ landed', 'gate-failed': '⛔ gate red — reverted', 'apply-failed': '⛔ apply failed' };
let _lastApprovalSig = '';
function renderApprovals(items) {
  if (!approvalsBar) return;
  try {
    _lastApprovalItems = items;
    // skip the wholesale rebuild when NOTHING changed (audit F30): every needless innerHTML
    // swap is a chance for the bar to shift under his cursor mid-aim
    const sig = JSON.stringify([items || [], [..._expandedCards], [..._collapsedCards]]);
    if (sig === _lastApprovalSig && approvalsBar.innerHTML) return;
    _lastApprovalSig = sig;
    if (!Array.isArray(items) || !items.length) { approvalsBar.classList.add('hidden'); approvalsBar.innerHTML = ''; return; }
    approvalsBar.classList.remove('hidden');
    const decidable = items.filter((i) => i.kind !== 'pen-run').length;
    const title = decidable ? `⏳ waiting on your word (${decidable})` : '🖊 pen pipeline — live';
    approvalsBar.innerHTML = `<div class="approvals-title">${title}</div>` + items.map((it) => {
      const isRun = it.kind === 'pen-run';
      const d = it.detail || null;
      const canExpand = !!(d && (d.diff || d.rationale || d.gateNote));
      const autoOpen = isRun && ['approved', 'applying'].includes(it.status);
      const open = canExpand && !_collapsedCards.has(String(it.id)) && (autoOpen || _expandedCards.has(String(it.id)));
      const chip = isRun ? (PEN_RUN_CHIP[it.status] || it.status) : (it.kind === 'blocked' ? 'blocked on you' : it.kind === 'pen' ? '🖊 code change' : 'proposed');
      const detail = canExpand ? `
        <div class="ac-detail">
          ${d.gateNote ? `<div class="ac-note">${escapeHtml(d.gateNote)}</div>` : ''}
          ${d.rationale ? `<div class="ac-rationale">${escapeHtml(d.rationale)}</div>` : ''}
          ${d.files && d.files.length ? `<div class="ac-files">${escapeHtml(d.files.join(' · '))}</div>` : ''}
          ${d.diff ? `<pre class="ac-diff">${escapeHtml(d.diff)}</pre>` : ''}
        </div>` : '';
      return `
      <div class="approval-card ${canExpand ? 'ac-can-expand' : ''} ${open ? 'ac-expanded' : ''} ${isRun ? `ac-run ac-run-${escapeHtml(String(it.status))}` : ''}" data-id="${escapeHtml(String(it.id))}">
        ${canExpand ? '<span class="ac-chev">▸</span>' : ''}
        <span class="approval-kind ${it.kind === 'blocked' ? 'blocked' : 'proposed'}">${chip}</span>
        ${it.verdict ? `<span class="approval-verdict ${it.verdict}">${it.verdict === 'verified' ? '✓ verified' : '✗ rejected'}</span>` : ''}
        <span class="approval-text">#${escapeHtml(String(it.id))} — ${escapeHtml(it.text)}</span>
        ${isRun
    ? (['applied', 'gate-failed', 'apply-failed'].includes(it.status) ? '<span class="approval-actions"><button type="button" class="approval-seen" title="Clear this finished run from the bar">✕</button></span>' : '')
    : `<span class="approval-actions">
          <button type="button" class="approval-yes" title="${it.kind === 'blocked' ? 'Done / unblocked — she re-checks it' : it.kind === 'pen' ? 'Yes — apply it: clean tree, full gate, commit on green, revert on red' : 'Yes — build it (back into the open queue with your blessing)'}">✓ yes</button>
          <button type="button" class="approval-no" title="No — retire it">✗ no</button>
        </span>`}
        ${detail}
      </div>`;
    }).join('');
  } catch { approvalsBar.classList.add('hidden'); }
}
let _armApproval = null;   // the card he AIMED at, captured at mousedown (audit F30)
if (approvalsBar) {
  approvalsBar.addEventListener('mousedown', (e) => {
    const b = e.target.closest('button');
    const c = b && b.closest('.approval-card');
    _armApproval = c ? { id: String(c.dataset.id), ts: Date.now() } : null;
  });
  approvalsBar.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) {
      // card-body click toggles the full view; clicks inside the detail (selecting diff text) don't collapse it
      if (e.target.closest('.ac-detail')) return;
      const xc = e.target.closest('.approval-card.ac-can-expand');
      if (xc) {
        const xid = String(xc.dataset.id);
        if (xc.classList.contains('ac-expanded')) { _expandedCards.delete(xid); _collapsedCards.add(xid); }
        else { _expandedCards.add(xid); _collapsedCards.delete(xid); }
        renderApprovals(_lastApprovalItems);
      }
      return;
    }
    const card = btn.closest('.approval-card');
    if (!card) return;
    // THE AIM GUARD (audit F30): if a background push re-rendered the bar between his mousedown
    // and this click, the card under the cursor can be a DIFFERENT proposal (a fresh filing
    // sorts in above his target). A mismatched aim is swallowed — a ✓ must never land on a
    // card he did not read.
    if (_armApproval && Date.now() - _armApproval.ts < 1500 && _armApproval.id !== String(card.dataset.id)) {
      console.warn('[approvals] click swallowed — the bar shifted under the cursor'); _armApproval = null; return;
    }
    _armApproval = null;
    const id = /^pen-/.test(card.dataset.id) ? card.dataset.id : Number(card.dataset.id);   // pen cards carry string ids
    const decision = btn.classList.contains('approval-seen') ? 'seen' : btn.classList.contains('approval-yes') ? 'yes' : 'no';
    btn.disabled = true;
    try {
      const r = await window.sq.needsDecide(id, decision);
      renderApprovals(r && r.items);
    } catch { btn.disabled = false; }
  });
  if (window.sq.onNeedsApprovals) window.sq.onNeedsApprovals((info) => renderApprovals(info && info.items));
}
async function loadApprovals() {
  try { const r = await window.sq.needsPending(); renderApprovals(r && r.items); } catch {}
}

async function init() {
  const name = await window.sq.getMeta('user_name');
  if (!name) {
    showNameCapture();
  } else {
    await loadHistory();
    await loadSheep();
    await loadApprovals();
    input.focus();
  }
}

init();
