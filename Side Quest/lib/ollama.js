const OLLAMA_BASE = process.env.OLLAMA_BASE || 'http://localhost:11434';

// keep_alive policy (2026-08-16, Lucas). A CLOUD call (base != local) is proxied to ollama.com, which does
// NOT hold local VRAM — a long keep_alive is harmless there. A LOCAL call pins the model in the RX 7900 XT's
// VRAM for the whole window, and the ONLY thing that runs local now is the demoted-cold front FALLBACK (it
// fires when the cloud is throttled/down; chat + musings are cloud). A 24h pin meant one transient cloud blip
// squatted 8.4 GB for a full day, defeating the 08-04 "front cold, VRAM reserved for image-gen" intent. So a
// local call gets a SHORT keep_alive → the fallback model unloads when idle. Env-tunable (ZOE_LOCAL_KEEP_ALIVE);
// the explicit boot warm-hold (ZOE_WARM_FRONT, main.js) still pins its own 24h independently of this default.
function _keepAlive(base) {
  const isCloud = !!(base && base !== OLLAMA_BASE);
  return isCloud ? '24h' : (String(process.env.ZOE_LOCAL_KEEP_ALIVE || '').trim() || '5m');
}

// TRANSIENT CONCURRENCY 429 BACKOFF (2026-08-16). ollama.com admits a bounded number of concurrent
// requests per account (measured live: ~12 clean, HTTP 429 "too many concurrent requests" past ~12-19).
// A wide swarm (up to config.maxWorkers, each operator turn firing several nested calls) can transiently
// exceed it — this is the choke point where that 429 is born and where every concurrent cloud caller
// passes, so a short JITTERED backoff-and-retry here lets a burst DEGRADE GRACEFULLY instead of failing
// tasks. Only the initial admission (before any token/body is consumed) is retried, so an in-progress
// stream is never re-issued. Returns true if it waited (caller should re-fetch), false if the error is
// not a retryable concurrency-429 or the retry budget/abort is spent. Jitter (Math.random) de-syncs N
// workers so they don't all retry in lockstep and re-collide.
const _CONCURRENCY_429_RE = /concurrent|too many|rate.?limit/i;
async function _maybeBackoff429(status, bodyText, attempt, ctrl, model, { maxRetries = 3, baseMs = 400 } = {}) {
  if (status !== 429 || attempt >= maxRetries) return false;
  if (!_CONCURRENCY_429_RE.test(String(bodyText || ''))) return false;   // a different 429 (e.g. a daily quota) — surface it, don't hide it behind retries
  if (ctrl && ctrl.signal && ctrl.signal.aborted) return false;          // watchdog/maxTimer already fired → don't wait, let the abort surface
  const delay = Math.round(baseMs * Math.pow(2, attempt) * (0.5 + Math.random()));   // 400/800/1600ms ±50% jitter
  try { console.warn(`[ollama] ${model || '?'} 429 too-many-concurrent — backoff ${delay}ms (retry ${attempt + 1}/${maxRetries})`); } catch {}
  await new Promise((r) => setTimeout(r, delay));
  return true;
}

// `base` + `headers` mirror completeDetailed, so this can stream from the CLOUD tier and not just
// localhost. It was hardcoded to OLLAMA_BASE, which is the only reason cloud answers had to be
// fetched as one blocking block: the endpoint speaks the same /api/chat streaming protocol, we
// simply had no way to point this at it or to attach the bearer token. That mattered once the cloud
// started writing the user-facing reply — a long generation with no token flow is indistinguishable
// from a hang, and the stall watchdog below only works if tokens are actually arriving to reset it.
// ENTROPY-governed sampling policy (Wave 2, docs/PRE_HARD_TESTING_SCOPE_2026-08-18.md). Returns a COPY
// of options with the reproducibility mode applied: temperature → 0 (greedy) in deterministic mode, the
// real temperature otherwise, and a FIXED ollama seed threaded in the test modes (seeded/deterministic)
// or whenever ZOE_ENTROPY_SEED is pinned — so the daemon's own sampling replays run-to-run. Prod-default
// is a no-op (base temperature, no forced seed). "Smooth dynamics, never source": it only moves a
// sampling knob toward determinism; the fact path (completeDetailed) is temperature 0 already, untouched.
function _govern(options) {
  const o = Object.assign({}, options);
  try {
    const _ent = require('./entropy');
    if (o.temperature != null) o.temperature = _ent.temperature('ollama.sample', o.temperature);
    if (_ent.getMode() !== 'prod' || process.env.ZOE_ENTROPY_SEED) o.seed = Number(_ent.getSeed() % 2147483647n);
  } catch { /* entropy must never block a generation */ }
  return o;
}

async function streamChat({ model, messages, options = {}, onToken, onThinking, signal, inactivityMs = 90000, maxMs = 0, think, base = OLLAMA_BASE, headers = {}, lane = undefined }) {
  // AMBIENT SPEND-TIER FALLBACK (2026-08-12 review M5): a caller that doesn't know its tier inherits
  // the run's ambient spendTier (declared once by the orchestrator via lane.run) before the legacy
  // 'interactive' default. Explicit lane always wins; a bare legacy call outside any run stays
  // interactive — the mute-safety invariant below is unchanged.
  if (lane == null) { try { lane = require('./lane').ambientSpendTier() || 'interactive'; } catch { lane = 'interactive'; } }
  const body = {
    model,
    messages,
    stream: true,
    keep_alive: _keepAlive(base),
    options: {
      temperature: 0.8,
      top_p: 0.9,
      repeat_penalty: 1.1,
      num_ctx: 8192,
      ...options
    }
  };
  // Wave 2 reproducibility: collapse expressive sampling in a test mode (temperature → 0 in
  // deterministic mode; a fixed seed threaded in the test modes) so a turn is diffable run-to-run.
  body.options = _govern(body.options);
  // Optional top-level `think` toggle for reasoning models (ollama /api/chat) — e.g. the meeting
  // scribe disables thinking so its whole budget goes to the minutes, not hidden reasoning.
  if (typeof think === 'boolean') body.think = think;

  // TRUTH-IN-LOGGING (2026-07-30): a prompt beyond the window is SILENT data loss — the daemon
  // keeps the LAST half-window and drops the front (measured live: a 72,048-token prompt cut to
  // 4,099, 94% gone, zero app-side error). Estimate cheap and NAME THE CALLER, so the next
  // offender is one grep away instead of a forensic hunt. Conservative 3.2 chars/token — only
  // real overflows warn.
  try {
    const _chars = (messages || []).reduce((n, m) => n + String((m && m.content) || '').length, 0);
    const _ctx = (body.options && body.options.num_ctx) || 8192;
    if (_chars / 3.2 > _ctx) {
      const _at = String((new Error().stack || '').split('\n').slice(2, 5).join(' | ')).replace(/\s+/g, ' ').slice(0, 300);
      console.warn(`[window] ${model} prompt ~${_chars}ch ≈ ${Math.round(_chars / 3.6)}tok vs num_ctx ${_ctx} — the daemon will SILENTLY truncate; fit the prompt upstream. at: ${_at}`);
    }
  } catch { /* estimation must never block a call */ }

  // ⭐M1.1b SPEND GATE AT THE CHOKE POINT. Every cloud generation passes through here, so this is the one
  // place a pool ceiling can actually bind (Disease A: the reply path + curator + research all bypassed the
  // idle-only gate). MUTE-SAFETY INVARIANT: only CLOUD calls on an OPT-IN deferrable lane are ever gated —
  // lane defaults to 'interactive', which is NEVER deferred, so the reply path and every legacy caller are
  // untouched. A deferral throws a typed {deferred:true} error that only the opt-in caller catches (it then
  // falls back to local / skips). The gate itself FAILS OPEN: any gate-infra error proceeds with the call.
  const _cloudCall = !!(base && base !== OLLAMA_BASE);
  if (_cloudCall && lane && lane !== 'interactive') {
    try {
      const _chars = (messages || []).reduce((n, m) => n + String((m && m.content) || '').length, 0);
      const _estTokens = Math.round(_chars / 3.2) + 500;   // prompt + a nominal completion
      const _est = require('./quota').costOf({ model, tokens: _estTokens });
      const _r = require('./quota_gate').allow(lane, { estimate: _est });
      if (!_r.allow) { const e = new Error(`quota: ${lane} deferred — ${_r.reason}`); e.deferred = true; e.lane = lane; throw e; }
    } catch (e) { if (e && e.deferred) throw e; /* gate infra failure → FAIL OPEN, make the call */ }
  }

  // WATCHDOG: abort if the stream STALLS (no token for inactivityMs). Without this a hung
  // generation blocks the awaiting caller forever — and since there's one local model
  // instance, that freezes BOTH the idle loop AND chat (observed: a 15-min wedge). The timer
  // resets on every chunk (so a slow-but-progressing reply is never killed) and composes with
  // any externally-passed signal. On fire/abort the fetch rejects → the caller's try/catch
  // recovers and the loop ticks again.
  const ctrl = new AbortController();
  const onExternalAbort = () => ctrl.abort();
  if (signal) { if (signal.aborted) ctrl.abort(); else signal.addEventListener('abort', onExternalAbort, { once: true }); }
  let watchdog = null;
  const kick = () => { if (inactivityMs > 0) { clearTimeout(watchdog); watchdog = setTimeout(() => ctrl.abort(), inactivityMs); } };
  // ABSOLUTE cap (2026-08-04): the inactivity watchdog RESETS on every token, so a reasoning model trickling
  // a long `thinking` stream is never killed — the interactive reply wedged ~10min on exactly that (kimi-k2.6).
  // maxMs is a HARD ceiling on total stream duration (set ONCE, never reset) that aborts regardless of token
  // activity. Default 0 = off (existing callers unchanged); reply-path callers pass it.
  const maxTimer = (maxMs > 0) ? setTimeout(() => { try { ctrl.abort(); } catch {} }, maxMs) : null;

  try {
    kick();
    // coalesce explicit null the same way completeDetailed does (default params only fill undefined)
    const _base = base || OLLAMA_BASE;
    const _reqInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      body: JSON.stringify(body),
      signal: ctrl.signal
    };
    // Retry the ADMISSION only (no tokens consumed yet) on a transient concurrency-429; backoff resets
    // the inactivity watchdog so the wait isn't counted as a stall. maxTimer still bounds total duration.
    let res;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(`${_base}/api/chat`, _reqInit);
      if (res.ok) break;
      const text = await res.text().catch(() => '');
      if (await _maybeBackoff429(res.status, text, attempt, ctrl, model)) { kick(); continue; }
      throw new Error(`Ollama HTTP ${res.status}: ${text || res.statusText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    // TEMP DIAG (2026-08-03): cloud streaming returns empty (text=0/thinking=0) while non-streaming
    // works. Dump the RAW stream head + headers for cloud calls to reveal the actual wire format.
    const _isCloud = !!(_base && _base !== OLLAMA_BASE);
    let _diagDumped = false, _anyChunk = false;
    if (_isCloud) { try { console.warn(`[stream-diag] ${model} status=${res.status} ct=${(res.headers.get && res.headers.get('content-type')) || '?'}`); } catch {} }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      kick();   // activity → reset the inactivity watchdog
      buf += decoder.decode(value, { stream: true });
      if (_isCloud && !_diagDumped) { _diagDumped = true; _anyChunk = true; try { console.warn(`[stream-diag] ${model} rawHead=${JSON.stringify(buf.slice(0, 500))}`); } catch {} }

      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.message && obj.message.content) {
            onToken(obj.message.content);
          }
          // ⭐ A REASONING MODEL PUTS MOST OF ITS GENERATION — INCLUDING HER TOOL TAGS — IN
          // `message.thinking`, and the streaming path used to drop it on the floor (633 tokens
          // generated, ~180 stored; the missing 450 were the tags. Live 2026-07-21, five runs).
          //
          // ⚠️ IT GOES TO ITS OWN CALLBACK, NEVER INTO THE TAG STREAM. The first fix wrapped it in
          // <think> and fed it through onToken — and broke chat COMPLETELY for a night: a reasoning
          // model NARRATES its own format ("We need to respond with <think> and <say>… the strict
          // format: <think> ... </think><say> ... </say>"), and the parser read those MENTIONS as
          // real tags. Every social reply became the literal "..." lifted from its format
          // recitation (#9235/#9239/#9242/#9245/#9256, night of 2026-07-21). A payload that can
          // contain tag-shaped text must never enter the tag stream — the caller gets it raw and
          // decides: record it as her interior, scan it for tool tags, never speak it.
          if (onThinking && obj.message && obj.message.thinking) {
            onThinking(obj.message.thinking);
          }
          if (obj.done) {
            try { const um = require('./usage_meter'); um.record(obj.model || (body && body.model), um.tokensOf({ prompt_eval_count: obj.prompt_eval_count, eval_count: obj.eval_count })); } catch {}   // meter real spend
            // THE WINDOW-EDGE TRIPWIRE (overrun guard, 08-26; caps-history round 4): a prompt riding
            // its num_ctx is SILENT quality loss — just-under leaves a generation sliver, just-over
            // front-truncates to half the window. One historic caller shipped 72k tokens (94%
            // discarded) and was never identified because nothing logged. Every stream now announces
            // the edge itself, whatever lane it came from — the ghost class is self-reporting.
            try {
              const _ctx = (body && body.options && body.options.num_ctx) || 0;
              const _pe = obj.prompt_eval_count || 0;
              if (_ctx && _pe >= _ctx * 0.9) console.warn(`[ollama] WINDOW EDGE — ${lane || 'unlabeled lane'} / ${obj.model || (body && body.model)}: prompt_eval ${_pe} of num_ctx ${_ctx}${obj.done_reason && obj.done_reason !== 'stop' ? ` (done_reason=${obj.done_reason})` : ''} — input may be front-truncated or the reply cut short`);
            } catch {}
            // Surface done_reason so callers can tell a real "stop" from a LOAD-ONLY close. On
            // ollama.com CLOUD a cold/rebalanced instance answers a stream:true request with a single
            // {done_reason:"load", content:""} chunk and closes WITHOUT generating (confirmed live
            // 2026-08-03: gemma non-streaming raw=259 vs the SAME model streaming text=0, seconds
            // apart). The reply path reads this to fall to a blocking completion instead of the weak
            // local voice.
            return { done_reason: obj.done_reason || null };
          }
        } catch {
          // ignore malformed line
        }
      }
    }
  } finally {
    clearTimeout(watchdog);
    clearTimeout(maxTimer);
    if (signal) { try { signal.removeEventListener('abort', onExternalAbort); } catch {} }
  }
}

/**
 * Non-streaming single completion → full assistant text. Used by deterministic callers (the
 * verification harness's homework-check + classify leaf) that need the WHOLE reply to parse into
 * a schema, not token-by-token. Low temperature by default (these are judgements, not prose).
 * Optional `base` selects a non-default endpoint (e.g. an Ollama-Cloud base for the frontier tier).
 */
// SLICE 2 (cloud-leverage) — a reasoning model (gpt-oss/qwen3/kimi/deepseek-r1…) emits a hidden
// chain-of-thought in message.thinking and can leave message.content EMPTY. `complete()`/.text callers then
// got "" even though the model produced output (the dossier=NULL / empty-section bug at small num_predict).
// pickText falls back to thinking so a reasoner never returns empty. A caller that wants CLEAN structured
// output still passes think:false (then content is populated and this fallback is inert). Pure.
function pickText(message) {
  const m = message || {};
  const c = (m.content != null ? String(m.content) : '').trim();
  return c || (m.thinking != null ? String(m.thinking) : '');
}

// TRUTH IN LOGGING — the fallback above is a SALVAGE, not an answer, and it was silent. Live
// 2026-07-31 the operator lane ran on a reasoner that isReasoningModel didn't know, so every
// research pass answered from chain-of-thought; one such pass reported "+26,164 new chars" and
// scored as the most productive pass of the run, because nothing distinguished CoT from findings.
// A caller that meant to get content and got deliberation instead should be able to SEE it, so the
// door names itself. First hit per model, then every 50th (visible without flooding the log).
const _thinkSalvage = new Map();
function _noteThinkingSalvage(model) {
  const k = String(model || '?');
  const n = (_thinkSalvage.get(k) || 0) + 1;
  _thinkSalvage.set(k, n);
  if (n === 1 || n % 50 === 0) {
    console.warn(`[ollama] ${k}: EMPTY content → answering from message.thinking (chain-of-thought salvaged as the answer)${n > 1 ? ` ×${n}` : ''} — this caller should pass think:false`);
  }
}
const _REASONING_RE = /(?:^|[\/:_-])(?:gpt-oss|qwen3|qwq|kimi|deepseek-r1|magistral|o1|o3|glm-5)\b|:think\b/i;
function isReasoningModel(name) { return _REASONING_RE.test(String(name || '')); }

async function completeDetailed({ model, messages, options = {}, base = OLLAMA_BASE, headers = {}, signal, timeoutMs = 180000, think, lane = undefined }) {
  // AMBIENT SPEND-TIER FALLBACK (2026-08-12 review M5): same as streamChat — condenseComplete's ~20
  // sites (incl. the autonomous research organize/merge/topical steps on the 120B) passed no lane
  // and silently billed 'interactive', bypassing the choke-point gate. They now inherit the
  // orchestrator's declared tier; explicit lane wins; bare legacy calls stay interactive.
  if (lane == null) { try { lane = require('./lane').ambientSpendTier() || 'interactive'; } catch { lane = 'interactive'; } }
  base = base || OLLAMA_BASE;          // coalesce explicit null (default params only fill undefined)
  headers = headers || {};
  // M1.1b SPEND GATE — the non-streaming twin of streamChat's choke-point gate (this door was
  // fully ungated: the operator loop + every condense/organize call ride completeDetailed, which
  // is where the beat lane's 400k+/h burn actually flowed). Same mute-safety invariant: only
  // CLOUD calls on an OPT-IN deferrable lane are ever gated; lane defaults to 'interactive'
  // (never deferred) so every legacy caller is untouched. Gate infra failure → FAIL OPEN.
  const _cloudCallCD = !!(base && base !== OLLAMA_BASE);
  if (_cloudCallCD && lane && lane !== 'interactive') {
    try {
      const _chars = (messages || []).reduce((n, m) => n + String((m && m.content) || '').length, 0);
      const _est = require('./quota').costOf({ model, tokens: Math.round(_chars / 3.2) + 500 });
      const _r = require('./quota_gate').allow(lane, { estimate: _est });
      if (!_r.allow) { const e = new Error(`quota: ${lane} deferred — ${_r.reason}`); e.deferred = true; e.lane = lane; throw e; }
    } catch (e) { if (e && e.deferred) throw e; /* fail open */ }
  }
  // Non-streaming: there's no per-token activity to watch, so cap the WHOLE call. Generous
  // (frontier/cloud models over a big context are slow) but bounded, so a hung request can't
  // block a caller forever the way the streaming path did. Composes with an external signal.
  const ctrl = new AbortController();
  const onExternalAbort = () => ctrl.abort();
  if (signal) { if (signal.aborted) ctrl.abort(); else signal.addEventListener('abort', onExternalAbort, { once: true }); }
  const timer = timeoutMs > 0 ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const _reqInit = {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
      body: JSON.stringify(Object.assign({
        model, messages, stream: false, keep_alive: _keepAlive(base),
        options: Object.assign({ temperature: 0, top_p: 0.9, num_ctx: 8192 }, options),
      }, typeof think === 'boolean' ? { think } : {})),   // think:false → reasoning models emit the answer directly, not hidden in `thinking`
      signal: ctrl.signal,
    };
    // Retry a transient concurrency-429 with jittered backoff — this is the non-streaming choke point the
    // swarm's operator turns ride (each fires several nested calls), so a wide burst degrades gracefully.
    // The timeoutMs timer still bounds the whole call (backoffs eat into it, ~2.8s max added).
    let res;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(`${base}/api/chat`, _reqInit);
      if (res.ok) break;
      const text = await res.text().catch(() => '');
      if (await _maybeBackoff429(res.status, text, attempt, ctrl, model)) continue;
      throw new Error(`Ollama HTTP ${res.status}: ${text || res.statusText}`);
    }
    const obj = await res.json();
    // Ollama reports token counts on the non-stream response — surface them so callers (the tiered
    // subconscious budget) can account real spend instead of estimating. prompt_eval_count = input,
    // eval_count = output.
    const usage = { prompt_tokens: (obj && obj.prompt_eval_count) || 0, eval_tokens: (obj && obj.eval_count) || 0 };
    try { const um = require('./usage_meter'); um.record((obj && obj.model) || model, um.tokensOf(usage)); } catch {}   // meter real spend (canvas usage pill)
    // THE WINDOW-EDGE TRIPWIRE, blocking twin (overrun guard 08-26 — see the streamChat site).
    try {
      const _ctx = (options && options.num_ctx) || 8192;
      if (_ctx && usage.prompt_tokens >= _ctx * 0.9) console.warn(`[ollama] WINDOW EDGE — ${lane || 'unlabeled lane'} / ${model}: prompt_eval ${usage.prompt_tokens} of num_ctx ${_ctx}${obj && obj.done_reason && obj.done_reason !== 'stop' ? ` (done_reason=${obj.done_reason})` : ''} — input may be front-truncated or the reply cut short`);
    } catch {}
    try {
      const _m = (obj && obj.message) || {};
      if (!(_m.content != null ? String(_m.content) : '').trim() && _m.thinking) _noteThinkingSalvage(model);
    } catch {}
    return {
      text: pickText(obj && obj.message),   // content, else thinking (a reasoner never returns empty — Slice 2)
      thinking: (obj && obj.message && obj.message.thinking) || '',   // reasoning models stash output here; a safety net for callers
      usage,
      model: (obj && obj.model) || model
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) { try { signal.removeEventListener('abort', onExternalAbort); } catch {} }
  }
}

// Back-compat string-returning wrapper (the vast majority of callers want just the text).
async function complete(opts) { return (await completeDetailed(opts)).text; }

/**
 * Splits a streamed string into <think>...</think> and <say>...</say> segments.
 * Streams say-content tokens to onSayToken as soon as they arrive.
 * Tolerates missing tags; finalize() salvages whatever was produced.
 *
 * TAG-DRIFT TOLERANCE: the 24B reliably means "interior" but often spells it
 * <thoughts> / <thinking> / <thought> instead of the canonical <think>. The old
 * parser only matched <think>, so a <thoughts> block left it stuck in 'pre' and
 * finalize() dumped the ENTIRE raw buffer (every thought block + tool tags) into
 * say — the "thought leak." We now treat all four spellings as interior, capture
 * MULTIPLE consecutive interior blocks, and NEVER let tag-shaped content fall
 * through into say. If she only journaled and never actually spoke, say is empty
 * (caller renders that as "…"), which is correct — silence beats a leaked interior.
 */
const THINK_OPEN = ['<think>', '<thoughts>', '<thinking>', '<thought>'];
const THINK_CLOSE = ['</think>', '</thoughts>', '</thinking>', '</thought>'];
const MAX_TOKEN_LEN = 11;  // longest tag above (</thinking>, </thoughts>) — straddle guard

// Earliest occurrence among a set of literal tokens. Returns { idx, token }.
function firstToken(buf, tokens) {
  let best = -1, bestTok = null;
  for (const t of tokens) {
    const i = buf.indexOf(t);
    if (i !== -1 && (best === -1 || i < best)) { best = i; bestTok = t; }
  }
  return { idx: best, token: bestTok };
}

// Strip complete tag blocks (<tag ...>…</tag>), self-closing tags (<tag/>), and
// stray open/close tags from a salvaged fragment, so leaked interior/tool tags
// (<thoughts>, <file-append>, <web-chat>, …) never reach the visible say. Used
// only on the no-<say> fallback path; genuine prose with no tags is untouched.
function stripTagBlocks(s) {
  if (!s) return '';
  return s
    .replace(/<([a-zA-Z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/g, '')
    .replace(/<[a-zA-Z][\w-]*\b[^>]*\/>/g, '')
    .replace(/<\/?[a-zA-Z][\w-]*\b[^>]*>/g, '')
    // A generation truncated mid-open-tag emits an INCOMPLETE tag with no closing '>' (e.g. a bare
    // "<think" when the reply is cut off right at the interior marker). None of the above match it, so
    // it used to survive into the visible say (the "<think" leak). Scrub a trailing partial open/close.
    .replace(/<\/?[a-zA-Z][\w-]*\b[^>]*$/g, '')
    .trim();
}

class TagStreamParser {
  constructor({ onSayToken } = {}) {
    this.onSayToken = onSayToken || (() => {});
    this.mode = 'pre'; // pre | think | between | say | post
    this.buf = '';
    this.thought = '';
    this.say = '';
    // THE POST CHANNEL (2026-08-15 deep-dive F1 — CRITICAL): the reply package instructs the model
    // to put action tags AFTER </say> — and that was the one position finalize() silently DELETED
    // (no post branch; line `this.buf = ''`). She would say "putting this on your canvas now" while
    // the tag that would do it evaporated: no dispatch, no error, no followup — the exact
    // advertised≠executed fabrication the doctrine forbids. Everything after </say>, plus the
    // between-section discards (a tag between </think> and <say> died the same way), now lands
    // here. post NEVER renders — consumers merge it into the THOUGHT-channel scan so the ~15 tag
    // executors see it; the visible say is untouched.
    this.post = '';
  }

  feed(chunk) {
    this.buf += chunk;
    let progress = true;
    while (progress) {
      progress = false;

      if (this.mode === 'pre') {
        // Earliest of any interior-open or <say>. Interior wins ties (it's the
        // intended first section). Nothing is emitted here, so no leak risk.
        const think = firstToken(this.buf, THINK_OPEN);
        const sayIdx = this.buf.indexOf('<say>');
        if (think.idx !== -1 && (sayIdx === -1 || think.idx < sayIdx)) {
          this.buf = this.buf.slice(think.idx + think.token.length);
          this.mode = 'think';
          progress = true;
        } else if (sayIdx !== -1) {
          // Model skipped interior and emitted <say> directly. Go straight to say.
          this.buf = this.buf.slice(sayIdx + '<say>'.length);
          this.mode = 'say';
          progress = true;
        }
      } else if (this.mode === 'think') {
        const close = firstToken(this.buf, THINK_CLOSE);
        if (close.idx !== -1) {
          this.thought += this.buf.slice(0, close.idx);
          this.buf = this.buf.slice(close.idx + close.token.length);
          this.mode = 'between';
          progress = true;
        } else if (this.buf.length > MAX_TOKEN_LEN) {
          // Flush safe portion (keep tail in case a close tag straddles the boundary)
          this.thought += this.buf.slice(0, this.buf.length - MAX_TOKEN_LEN);
          this.buf = this.buf.slice(-MAX_TOKEN_LEN);
        }
      } else if (this.mode === 'between') {
        // Either another interior block (multi-block journaling) re-enters think,
        // or <say> begins. Whichever comes first. Content before it used to be
        // DISCARDED as malformed junk — but a well-formed action tag placed there
        // (a real model habit) died silently with it (deep-dive F1). It now lands
        // in the post channel: still never rendered, but the executors can see it.
        const sayIdx = this.buf.indexOf('<say>');
        const think = firstToken(this.buf, THINK_OPEN);
        if (think.idx !== -1 && (sayIdx === -1 || think.idx < sayIdx)) {
          const dropped = this.buf.slice(0, think.idx);
          if (dropped.trim()) this.post += dropped;
          this.thought += '\n';  // separator between captured interior blocks
          this.buf = this.buf.slice(think.idx + think.token.length);
          this.mode = 'think';
          progress = true;
        } else if (sayIdx !== -1) {
          const dropped = this.buf.slice(0, sayIdx);
          if (dropped.trim()) this.post += dropped;
          this.buf = this.buf.slice(sayIdx + '<say>'.length);
          this.mode = 'say';
          progress = true;
        }
      } else if (this.mode === 'say') {
        const idx = this.buf.indexOf('</say>');
        if (idx !== -1) {
          const emit = this.buf.slice(0, idx);
          if (emit) {
            this.say += emit;
            this.onSayToken(emit);
          }
          this.buf = this.buf.slice(idx + '</say>'.length);
          this.mode = 'post';
          progress = true;
        } else if (this.buf.length > 6) {
          // Emit safe portion (keep last 6 in case </say> straddles)
          const safe = this.buf.slice(0, this.buf.length - 6);
          if (safe) {
            this.say += safe;
            this.onSayToken(safe);
          }
          this.buf = this.buf.slice(-6);
        }
      }
    }
  }

  finalize() {
    if (this.mode === 'pre') {
      // Never saw any interior or <say> tag — a plain reply. Emit as say, but
      // strip any tag-shaped artifacts defensively (no canonical tags were seen,
      // so genuine prose is unaffected).
      const salvaged = stripTagBlocks(this.buf);
      if (salvaged) { this.say = salvaged; this.onSayToken(salvaged); }
    } else if (this.mode === 'think') {
      // Unclosed interior block — keep it as thought, nothing leaks to say.
      if (this.buf) this.thought += this.buf;
    } else if (this.mode === 'between') {
      // Saw interior block(s) but no <say>. The remaining buffer is post-interior
      // content: salvage ONLY genuine prose for the say (tags stripped, so the
      // journal never dumps) — but the RAW buffer also rides the post channel
      // (deep-dive F1), so a well-formed action tag here is strip-AND-RUN, never
      // strip-and-silently-drop. A tag-only turn then follows the designed
      // tag-in-flight flow (no empty-say retry; the followup speaks the result).
      if (this.buf.trim()) this.post += this.buf;
      const salvaged = stripTagBlocks(this.buf);
      if (salvaged) { this.say = salvaged; this.onSayToken(salvaged); }
    } else if (this.mode === 'say') {
      // Unclosed <say> — a truncated reply. Its tail can carry a stray/leaked tag (a tool tag or a bare
      // "<think" the generation cut into), so scrub tag-shaped artifacts before emitting, same as the
      // pre/between salvage branches. Genuine prose with no tags is untouched.
      const salvaged = stripTagBlocks(this.buf);
      if (salvaged) {
        this.say += salvaged;
        this.onSayToken(salvaged);
      }
    }
    // The post-mode buffer is the documented tag position (deep-dive F1) — everything after
    // </say> returns on the post channel instead of being deleted here.
    if (this.mode === 'post' && this.buf.trim()) this.post += this.buf;
    this.buf = '';
    return {
      thought: this.thought.trim(),
      say: this.say.trim(),
      post: this.post.trim(),
      truncated: this.mode !== 'post' ? 1 : 0
    };
  }
}

// PURE: does a reply look CUT OFF mid-stream? finalize() sets truncated=1 whenever the stream ended
// without a closing </say> (mode !== 'post'). That alone isn't enough to regenerate — a long, fully
// formed reply that merely dropped its closing tag is fine. A reply is BROKEN only if it's truncated
// AND either very short (e.g. "Lucas.") or doesn't end on sentence-final punctuation (cut mid-clause,
// e.g. "…and will get that"). This is the signal the empty-say recovery was missing: our live
// failures were non-empty but truncated, so the (!say) test skipped them.
function sayLooksCutOff(say, truncated) {
  const s = String(say || '').trim();
  if (!truncated || !s) return false;                 // complete, or empty (handled elsewhere)
  if (s.length < 16) return true;                      // "Lucas." / "On it" — too short to be a real reply
  return !/[.!?]["'’”)\]]?$/.test(s);                  // longer, but ends mid-sentence → cut off
}

// --- Resident-model housekeeping --------------------------------------------
// A stale model pinned by keep_alive (e.g. one loaded before a model swap/reboot) squats VRAM and
// collides with the front model — the "call goes nowhere" hang. At boot we sweep any big resident
// model that isn't the one(s) we mean to keep.

// PURE: pick resident models to evict — not in `keep`, big enough to matter (skip tiny embedding
// models, which are cheap and needed). Separated from IO so the decision is unit-testable.
function selectStale(loaded, { keep = [], minVramBytes = 2e9 } = {}) {
  const keepSet = new Set((keep || []).filter(Boolean));
  return (loaded || [])
    .filter(m => m && m.name && !keepSet.has(m.name)
      && (m.size_vram || m.size || 0) >= minVramBytes
      && !/bge|embed|nomic|minilm/i.test(m.name))
    .map(m => m.name);
}

async function listLoaded({ base = OLLAMA_BASE } = {}) {
  try {
    const res = await fetch(`${base}/api/ps`);
    if (!res.ok) return [];
    const j = await res.json();
    return (j && j.models) || [];
  } catch { return []; }
}

async function unload(model, { base = OLLAMA_BASE } = {}) {
  try {
    await fetch(`${base}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
    });
    return true;
  } catch { return false; }
}

// Boot housekeeping: unload stale big residents, keeping the front (and whatever else is passed).
// Fail-safe: any error → returns [] (never blocks boot). Returns the names it unloaded.
async function sweepLoaded({ keep = [], minVramBytes = 2e9, base = OLLAMA_BASE } = {}) {
  try {
    const stale = selectStale(await listLoaded({ base }), { keep, minVramBytes });
    for (const m of stale) await unload(m, { base });
    return stale;
  } catch { return []; }
}

// BETWEEN-TURN COGNITION router. The idle loops (heartbeat surfacing, self-dialogue, boredom
// query-pick) were built when the LOCAL front was hot and drove them directly. After the front was
// demoted to a cold fallback (VRAM reserved for image-gen), those loops still called the local model
// on their own schedule — each call re-loaded gemma AND re-pinned it 24h via the keep_alive default,
// so the "demoted" model was resident and continuously fed. This routes that cognition to the CLOUD
// subconscious model (already warm, zero local VRAM) when one is configured, mirroring
// monologue.generateThought's cloud-first policy — while preserving token streaming (parser.feed /
// sheep). Falls back to the local front model ONLY if no cloud subconscious is set or no cloud source
// is reachable, so the local model stays genuinely COLD unless the cloud is truly unavailable.
/**
 * cognitionWindow — the context window an idle-COGNITION call will actually be served.
 *
 * streamCognition (below) routes to the CLOUD subconscious model (kimi, 262k) whenever a cloud source
 * with a token is configured — by THIS very check — else the local front model (8k). A caller that
 * trims its own prompt before handing it over (the heartbeat's fitToWindow) must budget against the
 * model that will serve, not the legacy hardcoded 8192 — that number is the LOCAL model's window (see
 * lib/cloud_window), and sizing the cloud heartbeat to it front-dropped ~10 turns of conversation
 * every tick against 1/16th of kimi's real window. Cached per model by cloud_window → a Map hit after
 * the first tick. Deps are injectable for tests. Never throws; fails safe to the 8192 floor.
 */
async function cognitionWindow(deps = {}) {
  const FLOOR = 8192;
  try {
    const subconsciousModel = deps.subconsciousModel || require('./config').subconsciousModel;
    const sources = deps.sources || require('./models').sources;
    const resolve = deps.resolve || require('./cloud_window').resolve;
    const subModel = subconsciousModel();
    if (!subModel) return { num_ctx: FLOOR, isCloud: false, model: null };
    const cloud = (sources() || []).find(s => s.tier === 'cloud' && s.token);
    if (!cloud) return { num_ctx: FLOOR, isCloud: false, model: subModel };
    const w = await resolve({ model: subModel, base: cloud.base, token: cloud.token });
    return { num_ctx: (w && w.num_ctx) ? w.num_ctx : FLOOR, isCloud: true, model: subModel };
  } catch { return { num_ctx: FLOOR, isCloud: false, model: null }; }
}

// THE LOCAL FLOOR IS AN ABSOLUTE EXTREME LAST RESORT (Lucas, 2026-08-21 — the max-out incident:
// a TRANSIENT cloud-source blip loaded the 7.6GB local 12b onto a machine already carrying Echo's
// 8GB commit and ComfyUI's pinned reservation). The breaker: local engages ONLY on a SUSTAINED
// cloud absence (≥10min, incl. ≥10min of uptime so boot-hydration lag never counts). A blip skips
// the tick instead — idle cognition returning empty is benign by design ("nothing this tick").
const _CLOUD_BLIP_MS = 10 * 60 * 1000;
const _cognitionBoot = Date.now();
let _cloudLastSeenTs = 0;
async function streamCognition({ messages, options = {}, onToken, onThinking, signal, inactivityMs, maxMs, think, lane = 'idle' } = {}) {
  let subModel = '';
  try { subModel = require('./config').subconsciousModel(); } catch {}
  if (subModel) {
    let cloud = null;
    try { cloud = (require('./models').sources() || []).find(s => s.tier === 'cloud' && s.token); } catch {}
    if (cloud) {
      _cloudLastSeenTs = Date.now();
      // Idle cognition is a DEFERRABLE cloud lane — pass the lane so the choke-point gate can defer it when
      // the compute pool is low (protecting the interactive reply's headroom). A deferral is benign here:
      // swallow it into an empty cognition ("nothing this tick") rather than throwing into the idle loops.
      try {
        return await streamChat({
          model: subModel, messages, options, onToken, onThinking, signal, inactivityMs, maxMs, think,
          base: cloud.base, headers: cloud.token ? { Authorization: `Bearer ${cloud.token}` } : {}, lane
        });
      } catch (e) {
        if (e && e.deferred) { try { console.log(`[quota] cognition (${lane}) deferred — ${e.message}`); } catch {} return ''; }
        throw e;
      }
    }
  }
  // Local fallback — the demoted front model. ABSOLUTE EXTREME LAST RESORT: only a SUSTAINED
  // cloud absence reaches it; a blip (or boot-hydration lag) skips the tick instead of loading GBs.
  const _now = Date.now();
  const _sustainedOutage = (_now - _cognitionBoot >= _CLOUD_BLIP_MS)
    && (!_cloudLastSeenTs || _now - _cloudLastSeenTs >= _CLOUD_BLIP_MS);
  if (!_sustainedOutage) {
    try { console.log('[cognition] cloud source momentarily absent — tick skipped (the local floor is reserved for a sustained outage)'); } catch {}
    return '';
  }
  let front;
  try { front = require('./config').frontModel(); } catch { front = options.model; }
  try { console.log('[cognition] SUSTAINED cloud outage (≥10min) — the local last-resort floor engages'); } catch {}
  return streamChat({ model: front, messages, options, onToken, onThinking, signal, inactivityMs, maxMs, think });
}

module.exports = { streamChat, streamCognition, cognitionWindow, complete, completeDetailed, pickText, isReasoningModel, TagStreamParser, OLLAMA_BASE, selectStale, listLoaded, unload, sweepLoaded, sayLooksCutOff, _maybeBackoff429, _CONCURRENCY_429_RE, _keepAlive, _govern };
