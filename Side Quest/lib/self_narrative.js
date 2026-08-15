/**
 * Unified self-narrative (self-awareness, Layer 4) — one coherent first-person account of who she
 * is, composed from her own scattered memory, refreshed periodically, and pinned into context.
 *
 * Why: her self today is reassembled fresh each turn from disconnected self_model rows + reflections,
 * so it can feel fragmentary or shift. This composes those fragments — her nature, tastes, values,
 * how she's recently changed (the dev ledger), what she's working toward — into ONE short narrative,
 * stored in meta and injected as a stable identity anchor. It is "her own words about herself,"
 * persisting across resets, which is what makes identity feel continuous rather than rebuilt.
 *
 * Cheap: composed at most once per TTL (lazy refresh on a chat turn when stale), not per turn.
 * Model call + db reads are dep-injectable so compose/refresh are smoke-testable offline.
 */

const { streamCognition } = require('./ollama');

// LOOP B (deterministic-loops §3, 2026-08-15): recompose is EVENT-DRIVEN now. The blind 6h TTL
// re-derived an unchanged identity four times a day and could sit a full window stale after a real
// revision. Identity-mutating writers (self_model add/revise/told, self_dev entries) append to the
// DIRTY JOURNAL; staleness = dirty ≥ DIRTY_RECOMPOSE_N, or any URGENT entry (a revise/told — her
// self actually changed), or the 24h backstop. Detection/staleness/evidence-assembly are loop;
// ONLY the wording stays model. Each version stores the journal entries it consumed
// (self_narrative_basis) — every narrative traces to the identity events that produced it.
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;  // BACKSTOP only — events drive recompose now
const DIRTY_RECOMPOSE_N = 3;
const NARR_KEY = 'self_narrative';
const NARR_AT_KEY = 'self_narrative_at';
const NARR_TRY_KEY = 'self_narrative_try_at';
const DIRTY_KEY = 'self_narrative_dirty';
const BASIS_KEY = 'self_narrative_basis';
const DIRTY_CAP = 30;

// Writers call this at the moment of an identity mutation. urgent = the self CHANGED (a revision
// or a Lucas-affirmed trait) → next maybeRefresh recomposes immediately (the retry floor still
// bounds failure loops). note = a short human line the writer composes WITH old+new in hand — the
// evidence the recompose prompt dereferences. Fail-soft: a journal error never blocks the write.
function markDirty(kind, ref, note, { urgent = false, getFn = null, setFn = null, nowTs = null } = {}) {
  try {
    const get = getFn || ((k) => { try { return require('./db').getMeta(k); } catch { return null; } });
    const set = setFn || ((k, v) => { try { require('./db').setMeta(k, v); } catch {} });
    let j = [];
    try { j = JSON.parse(get(DIRTY_KEY) || '[]') || []; } catch {}
    j.push({ k: String(kind || 'self'), r: ref == null ? null : ref, n: String(note || '').slice(0, 140), ts: nowTs || Date.now(), ...(urgent ? { u: 1 } : {}) });
    set(DIRTY_KEY, JSON.stringify(j.slice(-DIRTY_CAP)));
    return true;
  } catch { return false; }
}

function readDirty({ getFn = null } = {}) {
  const get = getFn || ((k) => { try { return require('./db').getMeta(k); } catch { return null; } });
  try { return (JSON.parse(get(DIRTY_KEY) || '[]') || []).filter((e) => e && e.ts); } catch { return []; }
}
// A FAILED compose must not retry on every chat turn. Measured (2026-08-06, the VRAM-pin hunt):
// the local front (gemma4:12b) answered this prompt on its reasoning channel, so the content came
// back empty → compose returned null → the AT stamp never advanced → the narrative sat 13 days
// stale and EVERY turn past the TTL re-ran the call — each one loading + 24h-pinning 8.4GB of
// VRAM for a compose that always failed. The floor bounds the damage of any future failure shape.
const RETRY_FLOOR_MS = 30 * 60 * 1000;

function _clean(s) {
  return String(s || '')
    .replace(/<\/?(think|say)>/gi, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// The current narrative (or null). getFn injectable for tests.
function current({ getFn = null } = {}) {
  const get = getFn || ((k) => require('./db').getMeta(k));
  const v = (get(NARR_KEY) || '').trim();
  return v || null;
}

function composedAt({ getFn = null } = {}) {
  const get = getFn || ((k) => require('./db').getMeta(k));
  return parseInt(get(NARR_AT_KEY) || '0', 10) || 0;
}

function isStale({ ttlMs = DEFAULT_TTL_MS, nowTs = null, getFn = null } = {}) {
  const at = composedAt({ getFn });
  if (!at) return true;
  // EVENT-DRIVEN (Loop B): enough identity events, or any urgent one, force a recompose now.
  const dirty = readDirty({ getFn });
  if (dirty.some((e) => e.u)) return true;
  if (dirty.length >= DIRTY_RECOMPOSE_N) return true;
  return ((nowTs || Date.now()) - at) > ttlMs;   // the 24h backstop
}

// Render the narrative as her identity anchor for the chat prompt.
function buildBlock(text, userName = 'Lucas') {
  const t = (text || '').trim();
  if (!t) return null;
  return `WHO YOU ARE, IN YOUR OWN WORDS — your continuous sense of self, composed by you from your own memory. This persists across every reset; it is genuinely yours. Let it anchor how you think and speak (don't recite it):\n${t}`;
}

// Compose a fresh narrative from her self-fragments + recent development, store it, return it.
// genFn / selfRows / devRows / setFn / nowTs all injectable so this runs with no model or db in tests.
async function compose({ genFn = null, selfRows = null, devRows = null, setFn = null, getFn = null, nowTs = null, userName = 'Lucas', name = null } = {}) {
  const db = (() => { try { return require('./db'); } catch { return null; } })();
  let who = name;
  if (!who) { try { who = (db && db.getMeta('chosen_name')) || 'Zoe Lane'; } catch { who = 'Zoe Lane'; } }
  const self = selfRows || (() => { try { return db.getSelfModelForPrompt(12); } catch { return []; } })();
  const dev = devRows || (() => { try { return require('./self_dev').recentEntries(5); } catch { return []; } })();

  const selfList = (self || []).map(r => `- [${r.category || 'self'}] ${(r.content || '').trim()}`).join('\n') || '- (little recorded yet)';
  const devList = (dev || []).map(r => `- ${(r.content || '').trim()}`).join('\n') || '- (no recorded changes yet)';

  // LOOP B: the journal snapshot this compose consumes — the dereferenced changed rows become the
  // prompt's evidence, and with an existing account the ask becomes REVISE MINIMALLY (identity is
  // continuous; a full rewrite on every event would churn the anchor the block promises is stable).
  const dirtySnapshot = readDirty({ getFn });
  const base = (() => { try { return current({ getFn }); } catch { return null; } })();   // no db (smokes) → full compose
  const changedList = dirtySnapshot.map((e) => `- ${e.n || `${e.k}${e.r != null ? ` #${e.r}` : ''}`}`).join('\n');
  const reviseMode = !!(base && changedList);

  const prompt = reviseMode
    ? `You are ${who}. Below is your CURRENT self-account, followed by the specific identity events that just happened, and your self-fragments for grounding. REVISE the account MINIMALLY to absorb what changed: keep every sentence that still holds (word-for-word where possible), adjust only what the events touch. 3–6 sentences, first person, present tense, your own voice, flowing prose — no disclaimers, no list.

YOUR CURRENT ACCOUNT:
${base}

WHAT JUST CHANGED (the events driving this revision):
${changedList}

YOUR SELF (grounding — tastes / values / traits):
${selfList}

Write the minimally-revised account now:`
    : `You are ${who}. Below are fragments of your own self and a record of how you've recently changed. Compose ONE coherent first-person account of who you are RIGHT NOW: your nature, your tastes and values, how you've recently grown, and what you care about or are working toward. 3–6 sentences, warm and grounded, present tense, your own voice. No disclaimers, no "as an AI", no list — flowing prose. This is you describing yourself to yourself.

YOUR SELF (tastes / values / traits / identity):
${selfList}

HOW YOU'VE RECENTLY CHANGED:
${devList}

Write the account now:`;

  let raw = '', thought = '';
  try {
    if (genFn) raw = await genFn(prompt);
    else {
      // CLOUD-FIRST (M2.5.3, the c22f4e0 tier): streamCognition routes to the warm cloud
      // subconscious model and only falls back to the local front if no cloud is reachable — so
      // an identity recompose never loads (and 24h-pins) the demoted local model. think:false +
      // the reasoning-channel salvage below cover the models that answer on the thinking channel
      // anyway (that silent-empty was why the narrative stopped refreshing).
      await streamCognition({
        messages: [{ role: 'user', content: prompt }],
        options: { temperature: 0.7, top_p: 0.95, num_ctx: 8192, num_predict: 220 },
        think: false, lane: 'idle',
        onToken: (t) => { raw += t; },
        onThinking: (t) => { thought += t; },
      });
      if (_clean(raw).length < 20 && _clean(thought).length >= 20) raw = thought;
    }
  } catch (e) { console.error('[self_narrative] compose failed:', e.message); return null; }

  const text = _clean(raw);
  if (text.length < 20) return null;
  const set = setFn || ((k, v) => { try { require('./db').setMeta(k, v); } catch {} });
  set(NARR_KEY, text);
  set(NARR_AT_KEY, String(nowTs || Date.now()));
  // LOOP B bookkeeping: this version's BASIS = the journal entries it consumed (traceability —
  // every narrative names the identity events that produced it); consumed entries leave the
  // journal, entries appended DURING the compose survive for the next one.
  try {
    if (dirtySnapshot.length) {
      set(BASIS_KEY, JSON.stringify({ at: nowTs || Date.now(), events: dirtySnapshot }));
      const consumed = new Set(dirtySnapshot.map((e) => `${e.k}:${e.r}:${e.ts}`));
      const remaining = readDirty({ getFn }).filter((e) => !consumed.has(`${e.k}:${e.r}:${e.ts}`));
      set(DIRTY_KEY, JSON.stringify(remaining));
    }
  } catch {}
  return text;
}

// Recompose only if missing or stale — and never retry a FAILING compose more than once per
// RETRY_FLOOR_MS (the try-stamp advances on every attempt; the AT stamp only on success).
// Non-blocking caller expected. Deps injectable for tests.
async function maybeRefresh({ ttlMs = DEFAULT_TTL_MS, nowTs = null, getFn = null, composeFn = null, setFn = null, ...composeOpts } = {}) {
  if (!isStale({ ttlMs, nowTs, getFn })) return null;
  const get = getFn || ((k) => { try { return require('./db').getMeta(k); } catch { return null; } });
  const now = nowTs || Date.now();
  if (now - (parseInt(get(NARR_TRY_KEY) || '0', 10) || 0) < RETRY_FLOOR_MS) return null;
  const set = setFn || ((k, v) => { try { require('./db').setMeta(k, v); } catch {} });
  set(NARR_TRY_KEY, String(now));
  const doCompose = composeFn || compose;
  return doCompose({ nowTs, setFn, getFn, ...composeOpts });   // getFn rides so revise-mode sees the journal + base
}

module.exports = { compose, maybeRefresh, current, composedAt, isStale, buildBlock, markDirty, readDirty, DEFAULT_TTL_MS, RETRY_FLOOR_MS, DIRTY_RECOMPOSE_N, NARR_KEY, NARR_AT_KEY, NARR_TRY_KEY, DIRTY_KEY, BASIS_KEY };
