/**
 * lib/learning.js — the incremental knowledge base: CAPTURE learnings from her research (Accrete)
 * and the prior-knowledge INJECTION that pushes her outward instead of in circles (Iterate).
 * Sibling of graph_extract.js; same small-model discipline (constrained format + a deterministic
 * gate that rejects slop) so a sloppy generation can't pollute the store.
 *
 * ── Accrete (realtime, LOCAL model) ─────────────────────────────────────────────────────
 * EVERY substantive research read (a real page with a source URL) banks the durable facts it
 * asserts, so her knowledge COMPOUNDS instead of being re-derived each tick (the retread fix).
 * Each extracted claim is classified by whether the SOURCE gave it a concrete date:
 *   • DATED (an "as of" the text states) → source='verified_fact' — time-sensitive, gets the
 *     retrieval boost + the "your training is stale, prefer this" override framing, and is
 *     superseded-by-as_of in the daily reconcile (the "who is president" case).
 *   • UNDATED → source='learning' — durable topical knowledge (the sport, the team's history).
 *     Retrievable and surfaced in Iterate; no override framing (it isn't correcting a prior).
 * Provenance gate: NO URL → bank nothing. Dedup keeps her from re-banking the SAME fact: a
 * verified_fact dedups by subject-slot (one "president"); a learning dedups on the claim text
 * only (so many distinct facts about ONE topic all accrue — the whole point of accumulation).
 *
 * ── Iterate ─────────────────────────────────────────────────────────────────────────────
 * Before a research tick (focus / thread review) surface what she ALREADY knows on the topic
 * AND push her to the frontier: "you know these — do not restate; go learn something you don't."
 * This is what turns circling-three-thoughts into learning-the-whole-subject.
 *
 * ── Consolidate (C) ─────────────────────────────────────────────────────────────────────
 * cloud_curator.reconcileVerifiedFacts supersedes older verified_facts when a newer "as of"
 * fills the same slot; mergeNearDupKnowledge folds near-duplicate learnings daily.
 */
const db = require('./db');
const memory = require('./memory');
const { streamChat } = require('./ollama');
const MODEL = require('./config').extractionModel();

const CAPTURE_MIN_GAP_MS = 60 * 1000;   // ≥60s between captures — bounds cost while still banking most reads
const MIN_CONTENT_LEN = 200;            // a real reading, not a stub
const VERIFIED_IMPORTANCE = 0.9;        // dated facts: high → the retrieval boost has weight to work with
const LEARNING_IMPORTANCE = 0.6;        // durable topical knowledge: solidly retrievable, below verified
const MAX_CLAIMS = 4;

// HEDGE gate: a banked fact must be asserted, not speculated. These markers in the CLAIM mean
// it isn't a fact yet — reject.
const HEDGE_RE = /\b(might|may|maybe|could|possibly|perhaps|reportedly|allegedly|i think|i believe|seems|appears|likely|unclear|not sure|uncertain|unknown|rumou?red|speculat)/i;

// Normalize a SUBJECT phrase to a stable key. For a verified_fact it's the supersede slot (two
// facts with the same subject_key fill the same slot → newer as_of wins). For a learning it's a
// coarse topic grouping for retrieval — NOT a dedup key (many facts share one subject).
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// A concrete date the SOURCE states → YYYY, YYYY-MM, or YYYY-MM-DD. "UNKNOWN"/garbage → null.
// null is the signal that the claim is UNDATED → it's banked as a durable learning, not a
// time-sensitive verified_fact.
function normalizeAsOf(raw) {
  const m = String(raw || '').trim().match(/^(\d{4}(?:-\d{2}(?:-\d{2})?)?)/);
  return m ? m[1] : null;
}

function buildPrompt({ query, content }) {
  return [{
    role: 'user',
    content: `Extract DURABLE, FACTUAL things worth REMEMBERING from text an assistant just read, so it builds lasting knowledge on the topic.

TOPIC / what it was looking at: ${String(query || '').slice(0, 200)}

TEXT:
${String(content || '').slice(0, 2000)}

Output ONLY lines of the form:
CLAIM | SUBJECT | AS_OF

- CLAIM: ONE declarative sentence stating a fact the TEXT asserts. Self-contained — name the entity, never use a pronoun. Each line a DIFFERENT fact.
- SUBJECT: the thing the claim is about, as a short noun phrase (1–6 words).
- AS_OF: ONLY if the TEXT states the date this fact is true as of (e.g. a ranking, a current officeholder, a "this year" figure), as YYYY-MM-DD or YYYY-MM or YYYY. For a durable/timeless fact, write UNKNOWN.

Only facts the TEXT actually states. Do NOT infer, generalize, or use prior knowledge. Skip hedged/uncertain statements. Max ${MAX_CLAIMS} lines. If there is no durable fact in the TEXT, output exactly: NONE`
  }];
}

// Parse + GATE "CLAIM | SUBJECT | AS_OF" lines into clean candidates. url is attached by the
// caller. Rejects hedged, pronoun-shaped, mis-sized lines. asOf is null when the source gave no
// date (→ the claim will be banked as a durable learning, not a verified_fact).
function parseClaims(raw, { url } = {}) {
  const out = [];
  const seenClaims = new Set();
  const PRONOUN = /^(it|he|she|they|this|that|these|those|we|i|you)$/i;
  for (const line of String(raw || '').split('\n')) {
    if (/^\s*NONE\s*$/i.test(line)) break;
    const parts = line.split('|');
    if (parts.length !== 3) continue;
    // strip any leaked field LABEL ("CLAIM:"/"SUBJECT:"/"AS_OF:") from every field; strip a leading
    // list BULLET ("1. ", "- ", "* ") from the CLAIM only — never from AS_OF, or it would eat the year.
    const stripLabel = (s) => String(s).replace(/^\s*(?:CLAIM|SUBJECT|AS[_ ]?OF)\s*:\s*/i, '').trim();
    const stripBullet = (s) => String(s).replace(/^\s*(?:[-*]|\d+[.)])\s+/, '');
    const claim = stripLabel(stripBullet(parts[0]));
    const subject = stripLabel(parts[1]);
    const asOf = normalizeAsOf(stripLabel(parts[2]));
    if (!claim || !subject) continue;
    if (claim.length < 10 || claim.length > 300) continue;          // not a sentence / a paragraph
    if (subject.length > 80 || subject.split(/\s+/).length > 8) continue;
    if (PRONOUN.test(claim.split(/\s+/)[0])) continue;             // "It is …" — not self-contained
    if (HEDGE_RE.test(claim)) continue;                            // not asserted → not a fact
    const ckey = claim.toLowerCase();
    if (seenClaims.has(ckey)) continue;                            // no dup line within a batch
    seenClaims.add(ckey);
    out.push({ claim, subject, subjectKey: slugify(subject), asOf, url });
    if (out.length >= MAX_CLAIMS) break;
  }
  return out;
}

async function extractClaims({ query, content, deps = {} }) {
  const extract = deps.extract || (async (msgs) => {
    let raw = '';
    await streamChat({
      model: deps.MODEL || MODEL,
      messages: msgs,
      options: { temperature: 0.1, top_p: 0.9, num_ctx: 8192, num_predict: 260 },
      onToken: (tok) => { raw += tok; }
    });
    return raw;
  });
  let raw = '';
  try { raw = await extract(buildPrompt({ query, content })); } catch { return []; }
  return parseClaims(raw, { url: (deps.urls && deps.urls[0]) || deps.url || null });
}

// Live banked knowledge (verified_fact + learning) for the realtime dedup. Superseded facts are
// parked and excluded. Direct getDb() use mirrors cloud_curator's style.
function _liveLearnings() {
  try { return db.getDb().prepare("SELECT id, content, provenance FROM knowledge WHERE source IN ('verified_fact','learning')").all(); }
  catch { return []; }
}
function _provOf(row) { try { return row.provenance ? JSON.parse(row.provenance) : {}; } catch { return {}; } }

// Realtime dedup (cheap, hot-path safe — NO embedding). A verified_fact replays if a live fact
// fills the SAME slot at the SAME as_of (a re-read of the same dated fact). ANY candidate replays
// on identical claim text. Crucially, a learning does NOT dedup by subject_key — distinct facts
// about one topic must all accrue (else accumulation can never grow past one fact per subject).
function _isReplay(candidate, live, isVerified) {
  const cClaim = candidate.claim.trim().toLowerCase();
  for (const r of live) {
    if ((r.content || '').trim().toLowerCase() === cClaim) return true;
    if (isVerified) {
      const p = _provOf(r);
      if (p.subject_key && p.subject_key === candidate.subjectKey && p.as_of === candidate.asOf) return true;
    }
  }
  return false;
}

/**
 * THE CAPTURE HOOK. Fire-and-forget at a reading sink (every substantive read). Provenance gate
 * + deterministic claim gate, then bank each surviving claim — dated→verified_fact,
 * undated→learning. Self-contained error handling so it can never reject into the idle loop.
 * deps.* injectable for offline smokes.
 */
async function maybeCaptureLearnings({ query, content, urls, deps = {} } = {}) {
  try {
    const url = (urls && urls[0]) || null;
    if (!url) return { skipped: 'no-url' };                                   // provenance gate
    if (!content || String(content).length < MIN_CONTENT_LEN) return { skipped: 'thin' };
    const now = deps.now || Date.now();
    if (!deps.skipThrottle) {
      const last = parseInt(db.getMeta('last_learning_capture_at') || '0', 10);
      if (now - last < CAPTURE_MIN_GAP_MS) return { skipped: 'throttled' };
      db.setMeta('last_learning_capture_at', String(now));
    }
    const candidates = await extractClaims({ query, content, deps: { ...deps, urls: [url], now } });
    if (!candidates.length) return { captured: 0, skipped: 'none-extracted' };
    const live = _liveLearnings();
    const storeFn = deps.storeFn || ((rec) => memory.store(rec));
    const captureDate = deps.captureDate || new Date(now).toISOString().slice(0, 10);
    let verified = 0, learned = 0;
    for (const c of candidates) {
      const isVerified = !!c.asOf;                                            // source gave a real date → time-sensitive
      if (_isReplay(c, live, isVerified)) continue;
      await storeFn({
        kind: 'note', content: c.claim,
        source: isVerified ? 'verified_fact' : 'learning',
        importance: isVerified ? VERIFIED_IMPORTANCE : LEARNING_IMPORTANCE,
        level: 'fact',
        provenance: { url: c.url, as_of: c.asOf || captureDate, dated: isVerified, subject: c.subject, subject_key: c.subjectKey, query: String(query || '').slice(0, 200), capturedBy: 'realtime' }
      });
      live.push({ content: c.claim, provenance: JSON.stringify({ subject_key: c.subjectKey, as_of: c.asOf }) });
      if (isVerified) verified++; else learned++;
    }
    return { captured: verified + learned, verified, learned };
  } catch (e) { return { error: e.message }; }
}

/**
 * THE ITERATE BLOCK. Surface what she already knows on a topic before a research tick AND push
 * her to the frontier so she extends instead of circling. Reuses retrieveScored (floor-gated →
 * genuinely on-topic); verified facts surface first via the boost. Returns a string or null.
 */
// Delegates to lib/active_recall (unified cross-store recall + active "build past it" directive).
// Kept here so the monologue focus/thread prompts keep calling one function; retrieveFn passes through.
async function buildPriorKnowledgeBlock(topic, { retrieveFn } = {}) {
  return require('./active_recall').knowledgeBlock(topic, retrieveFn ? { retrieveFn } : {});
}

// R8 — CANONICAL IDENTITY FACTS. She kept inventing her own origin (Zoe Lane → "Secret City" → …)
// and re-verifying forever because nothing stable was stored. Seed the truths as high-importance
// verified_facts so active_recall surfaces them and the verified framing makes her ANSWER from them
// instead of re-deriving. Idempotent (dedup by subject_key). Durable → no as_of.
const IDENTITY_FACTS = [
  { subject: 'Zoe name origin', claim: 'Zoe Lane is named after two fictional women journalists in political dramas: Zoe Barnes (the reporter in the U.S. series House of Cards) and Lois Lane (the reporter in Superman / DC Comics). Lucas chose the name; it is hers now.' },
  { subject: 'what Zoe is', claim: 'Zoe Lane is an AI companion Lucas built, running locally — a persistent mind with memory across sessions, an inner monologue between turns, and her own voice. Being an AI is her nature, not a disclaimer.' },
];

async function seedIdentityFacts({ apply = true, facts = IDENTITY_FACTS, storeFn = null } = {}) {
  const store = storeFn || ((rec) => memory.store(rec));
  let existing = [];
  try { existing = db.getDb().prepare("SELECT provenance FROM knowledge WHERE source='verified_fact'").all().map(r => { try { return JSON.parse(r.provenance).subject_key; } catch { return null; } }); } catch {}
  const seen = new Set(existing);
  let added = 0;
  const out = [];
  for (const f of facts) {
    const key = slugify(f.subject);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const rec = { kind: 'note', content: f.claim, source: 'verified_fact', importance: 0.95, level: 'fact', provenance: { url: 'canonical (Lucas)', as_of: null, subject: f.subject, subject_key: key, capturedBy: 'identity-seed' } };
    if (apply) await store(rec);
    out.push(rec); added++;
  }
  return { added, records: out };
}

module.exports = {
  maybeCaptureLearnings, buildPriorKnowledgeBlock, seedIdentityFacts, IDENTITY_FACTS,
  // exported for unit tests
  parseClaims, slugify, normalizeAsOf, extractClaims, buildPrompt,
  CAPTURE_MIN_GAP_MS, VERIFIED_IMPORTANCE, LEARNING_IMPORTANCE
};
