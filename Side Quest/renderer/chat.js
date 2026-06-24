const transcript = document.getElementById('transcript');
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

const pendingAttachments = [];  // [{ name, text }]

function renderAttachments() {
  attachmentsBar.innerHTML = '';
  pendingAttachments.forEach((a, idx) => {
    const chip = document.createElement('span');
    chip.className = 'attachment-chip';
    const label = document.createElement('span');
    label.textContent = `${a.name} (${a.text.length} ch)`;
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
      const text = await f.text();
      const truncated = text.length > 50000 ? text.slice(0, 50000) : text;
      pendingAttachments.push({ name: f.name, text: truncated });
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

let liveSayBuffer = '';

function cleanLiveSay(s) {
  return (s || '')
    .replace(/<\/?think>/gi, '')
    .replace(/<\/?say>/gi, '')
    .replace(/<navigate>[^<]*<\/navigate>/gi, '')
    .replace(/<wonder>[\s\S]*?<\/wonder>/gi, '')
    .replace(/<\|[a-z_]+\|>/gi, '')   // tokenizer special tokens like <|system|>, <|user|>
    .replace(/<\|[a-z_]+/gi, '')       // unfinished tokenizer tokens still streaming
    .replace(/\*[^*\n]{1,200}\*/g, '') // asterisked stage directions
    .replace(/[ \t]+/g, ' ');
}

window.sq.onSayToken((token) => {
  if (!currentAiTurnDiv) {
    currentAiTurnDiv = makeAiTurn();
    currentAiSaidNode = makeSaidNode('');
    currentAiTurnDiv.appendChild(currentAiSaidNode);
    transcript.appendChild(currentAiTurnDiv);
    liveSayBuffer = '';
  }
  liveSayBuffer += token;
  currentAiSaidNode.textContent = cleanLiveSay(liveSayBuffer);
  scrollMaybe();
});

window.sq.onComplete((info) => {
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
    backfillThoughtIntoTurn(turnDiv, saidNode);
  }
  currentAiTurnDiv = null;
  currentAiSaidNode = null;
  liveSayBuffer = '';
  sending = false;
  input.disabled = false;
  input.focus();
});

async function backfillThoughtIntoTurn(turnDiv, saidNode) {
  try {
    const recent = await window.sq.getRecentHistory();
    // Find the most recent ai_said (the one we just stored)
    let lastSaid = null;
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i].speaker === 'ai_said') { lastSaid = recent[i]; break; }
    }
    if (!lastSaid) return;
    // Only pair if there is an ai_thought whose id is exactly lastSaid.id - 1
    let pairedThought = null;
    for (let i = 0; i < recent.length; i++) {
      if (recent[i].id === lastSaid.id - 1 && recent[i].speaker === 'ai_thought') {
        pairedThought = recent[i];
        break;
      }
    }
    if (pairedThought && turnDiv && saidNode && turnDiv.isConnected) {
      const existing = turnDiv.querySelector('.thought');
      if (!existing) {
        turnDiv.insertBefore(makeThoughtNode(pairedThought.content), saidNode);
      }
    }
  } catch (err) {
    console.error('thought backfill failed:', err);
  }
}

window.sq.onError((err) => {
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
  // Pair ai_thought with the following ai_said ONLY when adjacent (id+1).
  // Lone ai_thought rows (heartbeats with empty say) render distinctly so
  // they don't masquerade as prefixes for unrelated subsequent responses.
  const turns = await window.sq.getRecentHistory();
  let i = 0;
  while (i < turns.length) {
    const t = turns[i];
    if (t.speaker === 'user') {
      renderUserTurn(t.content);
      i++;
    } else if (t.speaker === 'ai_thought') {
      const next = turns[i + 1];
      if (next && next.speaker === 'ai_said' && next.id === t.id + 1) {
        renderHistoricalAiPair(t.content, next.content);
        i += 2;
      } else {
        // Lone thought — she contemplated and stayed silent
        renderSatWith(t.content);
        i++;
      }
    } else if (t.speaker === 'ai_said') {
      renderHistoricalAiPair(null, t.content);
      i++;
    } else {
      i++;
    }
  }
  transcript.scrollTop = transcript.scrollHeight;
}

async function loadSheep() {
  try {
    const monologue = await window.sq.getRecentMonologue(30);
    for (const m of monologue) {
      appendSheep({ ts: m.ts, content: m.content, type: m.type, query: m.query });
    }
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
