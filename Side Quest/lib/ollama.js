const OLLAMA_BASE = process.env.OLLAMA_BASE || 'http://localhost:11434';

async function streamChat({ model, messages, options = {}, onToken, signal, inactivityMs = 90000, think }) {
  const body = {
    model,
    messages,
    stream: true,
    keep_alive: '24h',
    options: {
      temperature: 0.8,
      top_p: 0.9,
      repeat_penalty: 1.1,
      num_ctx: 8192,
      ...options
    }
  };
  // Optional top-level `think` toggle for reasoning models (ollama /api/chat) — e.g. the meeting
  // scribe disables thinking so its whole budget goes to the minutes, not hidden reasoning.
  if (typeof think === 'boolean') body.think = think;

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

  try {
    kick();
    const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ollama HTTP ${res.status}: ${text || res.statusText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      kick();   // activity → reset the inactivity watchdog
      buf += decoder.decode(value, { stream: true });

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
          if (obj.done) {
            try { const um = require('./usage_meter'); um.record(obj.model || (body && body.model), um.tokensOf({ prompt_eval_count: obj.prompt_eval_count, eval_count: obj.eval_count })); } catch {}   // meter real spend
            return;
          }
        } catch {
          // ignore malformed line
        }
      }
    }
  } finally {
    clearTimeout(watchdog);
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
const _REASONING_RE = /(?:^|[\/:_-])(?:gpt-oss|qwen3|qwq|kimi|deepseek-r1|magistral|o1|o3)\b|:think\b/i;
function isReasoningModel(name) { return _REASONING_RE.test(String(name || '')); }

async function completeDetailed({ model, messages, options = {}, base = OLLAMA_BASE, headers = {}, signal, timeoutMs = 180000, think }) {
  base = base || OLLAMA_BASE;          // coalesce explicit null (default params only fill undefined)
  headers = headers || {};
  // Non-streaming: there's no per-token activity to watch, so cap the WHOLE call. Generous
  // (frontier/cloud models over a big context are slow) but bounded, so a hung request can't
  // block a caller forever the way the streaming path did. Composes with an external signal.
  const ctrl = new AbortController();
  const onExternalAbort = () => ctrl.abort();
  if (signal) { if (signal.aborted) ctrl.abort(); else signal.addEventListener('abort', onExternalAbort, { once: true }); }
  const timer = timeoutMs > 0 ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
      body: JSON.stringify(Object.assign({
        model, messages, stream: false, keep_alive: '24h',
        options: Object.assign({ temperature: 0, top_p: 0.9, num_ctx: 8192 }, options),
      }, typeof think === 'boolean' ? { think } : {})),   // think:false → reasoning models emit the answer directly, not hidden in `thinking`
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ollama HTTP ${res.status}: ${text || res.statusText}`);
    }
    const obj = await res.json();
    // Ollama reports token counts on the non-stream response — surface them so callers (the tiered
    // subconscious budget) can account real spend instead of estimating. prompt_eval_count = input,
    // eval_count = output.
    const usage = { prompt_tokens: (obj && obj.prompt_eval_count) || 0, eval_tokens: (obj && obj.eval_count) || 0 };
    try { const um = require('./usage_meter'); um.record((obj && obj.model) || model, um.tokensOf(usage)); } catch {}   // meter real spend (canvas usage pill)
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
        // or <say> begins. Whichever comes first. Content before it is discarded
        // (it's malformed between-section junk — e.g. a stray <file-append>).
        const sayIdx = this.buf.indexOf('<say>');
        const think = firstToken(this.buf, THINK_OPEN);
        if (think.idx !== -1 && (sayIdx === -1 || think.idx < sayIdx)) {
          this.thought += '\n';  // separator between captured interior blocks
          this.buf = this.buf.slice(think.idx + think.token.length);
          this.mode = 'think';
          progress = true;
        } else if (sayIdx !== -1) {
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
      // junk (tool tags, trailing fragments). Salvage ONLY genuine prose — in the
      // leak case this strips to empty, so say stays empty instead of dumping the
      // journal. A real reply written without <say> tags survives as prose.
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
    this.buf = '';
    return {
      thought: this.thought.trim(),
      say: this.say.trim(),
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

module.exports = { streamChat, complete, completeDetailed, pickText, isReasoningModel, TagStreamParser, OLLAMA_BASE, selectStale, listLoaded, unload, sweepLoaded, sayLooksCutOff };
