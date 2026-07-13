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
        const text = await f.text();
        const truncated = text.length > 50000 ? text.slice(0, 50000) : text;
        pendingAttachments.push({ name: f.name, text: truncated });
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
let unpromptedActive = false;      // the in-flight stream is an autonomous utterance
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
  transcript.appendChild(thinkingNode);
  scrollMaybe();
}
function hideThinking() {
  if (thinkingNode) { thinkingNode.remove(); thinkingNode = null; }
}

let liveSayBuffer = '';

function cleanLiveSay(s) {
  return (s || '')
    .replace(/<\/?think>/gi, '')
    .replace(/<\/?say>/gi, '')
    .replace(/<navigate>[^<]*<\/navigate>/gi, '')
    .replace(/<wonder>[\s\S]*?<\/wonder>/gi, '')
    .replace(/<\|[a-z_]+\|>/gi, '')   // tokenizer special tokens like <|system|>, <|user|>
    .replace(/<\|[a-z_]+/gi, '')       // unfinished tokenizer tokens still streaming
    // Markdown-italic markers: drop the ASTERISKS, keep the WORDS. The display never destroys content
    // (the old blanket strip ate "*Almost Famous*" → "My favorite movie is because…"). Whether stage
    // directions appear at all is the PROMPT's job, per mode (normal suppresses them; fantasy wants
    // them) — not the renderer's to guess and delete.
    .replace(/\*([^*\n]{1,200})\*/g, '$1')
    .replace(/[ \t]+/g, ' ');
}

window.sq.onSayToken((token) => {
  // Decide destination on the first token of a stream. A user-prompted reply streams into
  // the dialogue transcript; an autonomous (unprompted) utterance is buffered for the sheep
  // panel and never touches the transcript.
  if (!currentAiTurnDiv && !unpromptedActive) {
    if (promptedReplyPending) {
      hideThinking();
      currentAiTurnDiv = makeAiTurn();
      currentAiSaidNode = makeSaidNode('');
      currentAiTurnDiv.appendChild(currentAiSaidNode);
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
  if (!currentAiTurnDiv && (unpromptedActive || (info && (info.unprompted || info.silent)))) {
    const text = (info && typeof info.say === 'string' && info.say.trim())
      ? info.say.trim() : cleanLiveSay(unpromptedBuffer).trim();
    if (text) appendSheep({ ts: Date.now(), content: text, type: 'utterance' });
    unpromptedActive = false;
    unpromptedBuffer = '';
    return;
  }
  hideThinking();
  const turnDiv = currentAiTurnDiv;
  const saidNode = currentAiSaidNode;
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
  promptedReplyPending = true;   // the next streamed reply belongs in the transcript
  showThinking();
  const attachmentsToSend = pendingAttachments.slice();
  pendingAttachments.length = 0;
  renderAttachments();
  try {
    await window.sq.sendMessage(text || '(see attachments)', attachmentsToSend);
  } catch (err) {
    renderEphemeral(`— ${err.message || err} —`);
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
    dashboardBody.innerHTML = `<div class="dash-empty">Error: ${err.message}</div>`;
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

async function init() {
  const name = await window.sq.getMeta('user_name');
  if (!name) {
    showNameCapture();
  } else {
    await loadHistory();
    await loadSheep();
    input.focus();
  }
}

init();
