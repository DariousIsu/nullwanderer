/**
 * lib/ner.js — local Named Entity Recognition (tier 1 of the mention→object chain).
 *
 * The regex `extractEntity` mis-read the entity from ordinary questions ("Who is Donald Trump?" →
 * "Who" → resolved to a lobby firm), which starved the object-memory pull and left her answering
 * from bare training. This is the robust replacement: a real encoder NER (bert-base-NER) run
 * IN-PROCESS on the SAME transformers.js/WASM runtime that already serves the bge embedder — CPU
 * only, no GPU contention with the voice model, ~4–7 ms/query after a one-time model load.
 *
 * Tiering (lib/mention.js owns the escalation): this cased model nails explicit person/org spans
 * (the common "Who is X?" case). Its blind spots — lowercase, pronouns, KG-specific types
 * (bill/committee) — escalate to the cloud `decompose` extractor. A future upgrade could add a
 * local GLiNER tier for zero-shot KG types; the `gliner` npm package (0.0.x) had a broken
 * onnxruntime-web dependency at build time, so it was deferred rather than forced.
 *
 * Fully fail-safe: model can't load / bad input → detect() returns [] (the caller falls back to the
 * cloud tier, then the legacy regex). Never throws into a turn.
 */
const db = require('./db');

const NER_MODEL = 'Xenova/bert-base-NER';   // cased BERT NER (PER/ORG/LOC/MISC), ONNX for transformers.js
const MAX_NER_CHARS = 400;                  // a turn/utterance, not a document — keep it cheap
const MIN_SCORE = 0.5;                       // drop low-confidence tokens (the bi-encoder floor)

// bert-base-NER coarse labels → our Echo KG core entity_type (drives recallObject preferType).
// MISC is intentionally dropped: it's noisy (events/works/nationalities) and not a reliable object key.
const KIND_TO_KGTYPE = { PER: 'person', ORG: 'organization', LOC: 'place' };

let _ner = null;
let _loading = null;
let _failed = false;

// Lazy-load the token-classification pipeline once (mirrors memory.getExtractor). First call downloads
// the model into the app's data/models cache (~one-time); subsequent calls are instant.
async function getNer() {
  if (_ner) return _ner;
  if (_failed) return null;
  if (_loading) return _loading;
  _loading = (async () => {
    try {
      const { pipeline, env } = await import('@xenova/transformers');
      try { const path = require('path'); env.cacheDir = path.join(path.dirname(db.DB_PATH), 'models'); } catch {}
      _ner = await pipeline('token-classification', NER_MODEL);
      return _ner;
    } catch (e) {
      _failed = true; _loading = null;
      console.error('[ner] model load failed — falling back to cloud/regex extraction:', e.message);
      return null;
    }
  })();
  return _loading;
}

// Pre-warm at boot so the first factual turn isn't slowed by the model load (fire-and-forget, like
// memory.warm). Returns true if the NER is ready.
async function warm() { try { return !!(await getNer()); } catch { return false; } }
function ready() { return !!_ner; }

// Merge the per-token rows (B-/I- tags + ## wordpieces) into entity SPANS. Prefers char offsets to
// slice the ORIGINAL text (so "John F. Kennedy" stays intact, not "John F . Kennedy"); falls back to a
// punctuation-aware word join when the tokenizer gives no offsets.
function _aggregate(rows, text) {
  const spans = [];
  let cur = null;
  const flush = () => { if (cur) { spans.push(cur); cur = null; } };
  for (const r of rows || []) {
    const tag = String(r.entity || '');
    if (!tag || tag === 'O') { flush(); continue; }
    const kind = tag.replace(/^[BI]-/, '');
    const isBegin = tag.startsWith('B-');
    const w = String(r.word || '');
    const cont = w.startsWith('##');
    const hasOff = Number.isFinite(r.start) && Number.isFinite(r.end);
    if (cur && cur.kind === kind && (cont || !isBegin)) {
      // continuation of the same entity
      cur.end = hasOff ? r.end : cur.end;
      cur.tokens.push(w);
      cur.scoreSum += (r.score || 0); cur.n++;
    } else {
      flush();
      cur = { kind, start: hasOff ? r.start : null, end: hasOff ? r.end : null, tokens: [w], scoreSum: (r.score || 0), n: 1 };
    }
  }
  flush();
  return spans.map(s => {
    let surface;
    if (Number.isFinite(s.start) && Number.isFinite(s.end) && text) surface = text.slice(s.start, s.end);
    else surface = _joinTokens(s.tokens);
    return { text: (surface || '').trim(), kind: s.kind, kgType: KIND_TO_KGTYPE[s.kind] || null, score: s.scoreSum / s.n, start: s.start, end: s.end };
  }).filter(s => s.text);
}

// Fallback surface reconstruction from wordpieces: "##" attaches with no space; bare punctuation
// attaches to the previous token with no leading space ("F" + "." → "F.").
function _joinTokens(tokens) {
  let out = '';
  for (const t of tokens) {
    if (t.startsWith('##')) out += t.slice(2);
    else if (/^[^\w]$/.test(t) || /^[.,'’\-]/.test(t)) out += t;   // punctuation attaches
    else out += (out ? ' ' : '') + t;
  }
  return out;
}

// Detect entity spans in a short text. Returns [{text, kind, kgType, score, start, end}], highest score
// first. Fail-safe → [] on any error / model unavailable.
async function detect(text, { minScore = MIN_SCORE } = {}) {
  const t = String(text == null ? '' : text).slice(0, MAX_NER_CHARS);
  if (!t.trim()) return [];
  const ner = await getNer();
  if (!ner) return [];
  let rows;
  try { rows = await ner(t); } catch (e) { return []; }
  return _aggregate(rows, t).filter(s => s.score >= minScore).sort((a, b) => b.score - a.score);
}

// The single most salient entity to look up (tier-1 answer for the object pull). Prefers person/org
// over place; ties break on longer span then higher score. Returns {mention, kgType, score, kind} or
// null when no confident named entity is present (→ caller escalates to the cloud tier).
const _KIND_RANK = { person: 3, organization: 3, place: 1 };
async function topMention(text, opts = {}) {
  const spans = await detect(text, opts);
  if (!spans.length) return null;
  spans.sort((a, b) => {
    const kr = (_KIND_RANK[b.kgType] || 0) - (_KIND_RANK[a.kgType] || 0);
    if (kr) return kr;
    const lr = (b.text.length) - (a.text.length);
    if (lr) return lr;
    return b.score - a.score;
  });
  const best = spans[0];
  return { mention: best.text, kgType: best.kgType, score: best.score, kind: best.kind };
}

module.exports = { warm, ready, detect, topMention, _aggregate, _joinTokens, KIND_TO_KGTYPE };
