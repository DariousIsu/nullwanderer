/**
 * lib/capability_need.js — Slice R part 1 (PLAN_MAP_2026-07-23 §1): the NEED DETECTOR + store.
 *
 * The roster episode, measured: a run NAMED its missing capability ("a tool that can read XLS
 * files", "a Python script with pandas") in prose — and the sentence died in a findings doc.
 * Nothing connects a named need to the rehearsal sandbox that exists for exactly this, which is
 * why the rehearse move has fired ZERO times ever (it can only ADVANCE a run; nothing OPENS one).
 * This lib is the first half of the wire: detect the named-need shape in run text, land it as a
 * typed row, dedupe against open needs, and surface it (part 2: the decider's state line + the
 * rehearse OPEN form). R3 untouched throughout — the wire ends in a proposal card, never adoption.
 *
 * The detector is PURE regex + guards — the shape is narrow (four known patterns) and an LLM pass
 * would spend a cloud call per run to find them. Needs only come from text a RUN produced
 * (write-backs, outcome lines) — never from idle musing (Lucas's default: needs NAMED by failing
 * runs, not needs she infers idle). Offline-smokeable, fail-soft, no deletes (retire is a status).
 */
'use strict';

const str = (v) => (v == null ? '' : String(v));
function _db(deps) { return (deps && deps.db) || require('./db'); }

// ── the detector ──────────────────────────────────────────────────────────────────────────────
// A sentence names a capability need when it declares a missing MEANS in first person or flatly:
//   "I need a tool that can read XLS files"  ·  "this requires a Python script with pandas"
//   "no tool can parse the BIFF format"      ·  "unable to parse the spreadsheet"
// Guards keep out the shapes that burned the promised-lookup net: acknowledgments, questions,
// "no need to…", and hypotheticals about someone ELSE'S needs.
const _NEED_RES = [
  /\b(?:i|we)(?:['’]d| would)? need(?:s)? (?:a|an|another|some kind of|a new) [^.!?\n]{4,140}/i,
  /\b(?:this|it|that) (?:would )?requires? (?:a|an|another|a new) [^.!?\n]{4,140}/i,
  /\bno (?:tool|reader|parser|way) (?:can|to|exists? (?:that|to)) [^.!?\n]{4,140}/i,
  /\b(?:cannot|can['’]t|unable to) (?:read|parse|open|consume|extract|convert|decode) [^.!?\n]{4,140}/i,
];
const _NOT_A_NEED = [
  /\bno need\b/i,                          // "no need to re-search" is the opposite of a need
  /^\s*(?:understood|got it|okay|ok|sure|will do|noted)\b/i,   // acknowledgment opener
  /\?\s*$/,                                // a question is not a declaration
];

// Split run text into sentence-ish spans, return the ones that declare a need.
function detect(text) {
  const t = str(text);
  if (!t.trim()) return [];
  const out = [];
  for (const span of t.split(/(?<=[.!?])\s+|\n+/)) {
    const s = span.trim();
    if (s.length < 12 || s.length > 400) continue;
    if (_NOT_A_NEED.some((re) => re.test(s))) continue;
    for (const re of _NEED_RES) {
      const m = s.match(re);
      if (m) { out.push({ need: m[0].trim().replace(/\s+/g, ' ').slice(0, 200), sentence: s.slice(0, 300) }); break; }
    }
  }
  return out;
}

// ── the store ─────────────────────────────────────────────────────────────────────────────────
const _tokens = (s) => new Set((str(s).toLowerCase().match(/[a-z]{3,}/g) || []).filter((w) => !['the', 'and', 'that', 'can', 'with', 'for', 'need', 'needs', 'tool', 'this', 'would', 'requires', 'require'].includes(w)));
function _similar(a, b) {
  const ta = _tokens(a), tb = _tokens(b);
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const w of ta) if (tb.has(w)) hit++;
  return hit / Math.min(ta.size, tb.size);
}

// Land a need. Dedupes against OPEN/REHEARSING rows (a need already being worked must not fork);
// a retired/parked twin does NOT block — a need that comes back is a need again.
// similarFloor: callers whose need text carries a fixed boilerplate (self-watch's "recurring
// failure in my own program: <sig>") raise the floor so the shared preamble alone can't merge
// DISTINCT failures into one need. Default unchanged for every existing caller.
function record(need, { bornFrom = null, deps = {}, nowMs = Date.now(), similarFloor = 0.55 } = {}) {
  const n = str(need).replace(/\s+/g, ' ').trim();
  if (n.length < 12) return { id: null, reason: 'too short to be a real need' };
  try {
    const d = _db(deps).getDb();
    const bf = str(bornFrom).slice(0, 160);
    for (const row of d.prepare("SELECT id, need, born_from FROM capability_needs WHERE status IN ('open','rehearsing')").all()) {
      // SAME SOURCE = same gap. born_from is always a specific run/task key here (fill-gap:… / maintain:… /
      // inquiry-N-tM / research:Name — needs come only from RUNS, never a generic idle bucket), so an
      // identical born_from means a REPEAT of the same failure even when the model paraphrased the need
      // text. This is the actual dup bug: the "Oregon House committees" gap logged 3 open rows because each
      // rehearsal reworded it (<0.55 token overlap → the _similar check alone missed them) while the rehearse
      // loop never resolved any. Fold the repeat into the existing row (bump recurrence) instead of forking.
      if (bf && str(row.born_from) === bf) { try { d.prepare('UPDATE capability_needs SET updated_ts = ? WHERE id = ?').run(nowMs, row.id); } catch {} return { id: row.id, deduped: true }; }
      // A similarity fold is a RECURRENCE too — it must bump updated_ts (census 08-27: the curator's
      // dormancy clock keys off updated_ts, so an un-bumped fold let a still-recurring need age out).
      if (_similar(row.need, n) >= similarFloor) { try { d.prepare('UPDATE capability_needs SET updated_ts = ? WHERE id = ?').run(nowMs, row.id); } catch {} return { id: row.id, deduped: true }; }
    }
    const info = d.prepare('INSERT INTO capability_needs (need, born_from, status, created_ts, updated_ts) VALUES (?, ?, ?, ?, ?)')
      .run(n, str(bornFrom).slice(0, 160) || null, 'open', nowMs, nowMs);
    return { id: info.lastInsertRowid, deduped: false };
  } catch (e) { return { id: null, reason: e.message }; }
}

function listOpen({ deps = {} } = {}) {
  try { return _db(deps).getDb().prepare("SELECT * FROM capability_needs WHERE status = 'open' ORDER BY created_ts ASC").all(); } catch { return []; }
}
function get(id, { deps = {} } = {}) {
  try { return _db(deps).getDb().prepare('SELECT * FROM capability_needs WHERE id = ?').get(Number(id) || 0) || null; } catch { return null; }
}
function setStatus(id, status, { deps = {}, nowMs = Date.now() } = {}) {
  try {
    const r = _db(deps).getDb().prepare('UPDATE capability_needs SET status = ?, updated_ts = ? WHERE id = ?').run(str(status), nowMs, Number(id) || 0);
    return r.changes > 0;
  } catch (e) {
    // NEVER a silent swallow (census C2, 2026-08-27): the triage lane wrote CHECK-rejected statuses
    // for weeks and this catch ate every throw — the escalation door never fired and nothing could
    // tell. console.error is self_watch-visible: a recurring schema mismatch now mints a need.
    console.error(`[need] setStatus(${id}, '${str(status)}') FAILED: ${e.message}`);
    return false;
  }
}
// Store a Stage-2 repair diagnosis ON the need row (census wire 4) — the escalate-to-builder card
// reads it from here, and it survives the rehearsal-run meta being replaced (the C3 lesson).
function setDiagnosis(id, text, { deps = {}, nowMs = Date.now() } = {}) {
  try {
    const r = _db(deps).getDb().prepare('UPDATE capability_needs SET diagnosis = ?, updated_ts = ? WHERE id = ?').run(str(text).slice(0, 2500), nowMs, Number(id) || 0);
    return r.changes > 0;
  } catch (e) { console.error(`[need] setDiagnosis(${id}) FAILED: ${e.message}`); return false; }
}

// Scan run text and land every detected need. Returns the landed rows' ids (deduped included).
function harvest(text, { bornFrom = null, deps = {}, nowMs = Date.now() } = {}) {
  const found = detect(text);
  const ids = [];
  for (const f of found) {
    // THE CONTENT FIREWALL'S SINK (layer 3). This store is the ONE her fetched text can reach: a
    // page's words ride a research run into the cloud write-back, come back as `learned`/`next_step`,
    // and land here as a named need — which then reaches the decider and can open a rehearsal. By
    // this point the data frame is long gone (the model rewrote the words), so framing does not
    // protect transitively and the guard has to sit at the door. A need is her program describing
    // its own gap; anything phrased as an instruction to an actor came through her, not from her.
    try {
      const s = require('./content_firewall').screenNeed(f.need);
      if (!s.ok) {
        console.log(`[firewall] REFUSED a capability need from ${bornFrom || 'an unnamed run'} — ${s.why}: "${String(f.need).slice(0, 80)}"`);
        try { require('./obs_bus').emit({ lane: 'firewall', kind: 'need-refused', level: 'warn', text: `refused need from ${bornFrom || 'unnamed'} — ${s.why}: "${String(f.need).slice(0, 90)}"`, ref: String(bornFrom || ''), data: { category: s.category } }); } catch {}
        continue;
      }
    } catch {}
    const r = record(f.need, { bornFrom, deps, nowMs });
    if (r.id != null) ids.push({ id: r.id, deduped: !!r.deduped, need: f.need });
  }
  return ids;
}

// ── suite matching (which smoke judges a need-born rehearsal) ────────────────────────────────
// A rehearsal run iterates against a NAMED suite. For a need-born run, pick the existing smoke
// whose name shares the most distinctive tokens with the need ("read XLS files" →
// smoke_sheet_extract via 'xls'? no — via explicit token map + filename tokens). Returns null
// when nothing plausibly fits — an honest null parks the need for Lucas instead of iterating
// against an unrelated bar.
// Format words expand to the vocabulary suite FILENAMES actually use — "read XLS files" must
// find smoke_sheet_extract even though they share zero literal tokens. Small and extendable.
const _ALIASES = { xls: ['sheet', 'spreadsheet', 'extract'], xlsx: ['sheet', 'spreadsheet', 'extract'], csv: ['sheet', 'spreadsheet'], spreadsheet: ['sheet'], pdf: ['extract', 'doc'], email: ['mail'], webpage: ['web'], website: ['web'] };
// §55b (the 101x cure): need-81 ("access to STATE legislative bill metadata") bound to
// smoke_avatar_STATE.js on the lone generic token 'state' — program-state vs US-state — and the
// run flailed against a stranger's code 101 times in 7 days. A single GENERIC token never binds
// a suite; one SPECIFIC token or two tokens still do (smoke_calendar for a calendar need stays).
const _GENERIC_SUITE_TOKENS = new Set(['state', 'data', 'lane', 'test', 'tests', 'check', 'run', 'live', 'main', 'self', 'file', 'files', 'page', 'user', 'time', 'queue', 'list', 'store', 'cache', 'core', 'info', 'text']);
function suiteFor(need, suiteNames = []) {
  const nt = _tokens(need);
  for (const w of [...nt]) if (_ALIASES[w]) for (const a of _ALIASES[w]) nt.add(a);
  let best = null, bestScore = 0;
  for (const name of suiteNames) {
    const ft = new Set((str(name).toLowerCase().match(/[a-z]{3,}/g) || []).filter((w) => w !== 'smoke'));
    const hits = [...ft].filter((w) => nt.has(w));
    const specific = hits.filter((w) => !_GENERIC_SUITE_TOKENS.has(w));
    const score = (specific.length >= 1 || hits.length >= 2) ? hits.length + specific.length : 0;
    if (score > bestScore) { bestScore = score; best = name; }
  }
  return bestScore > 0 ? best : null;
}

// ── the decider's state line (part 2 consumes this) ──────────────────────────────────────────
function manifestLines({ deps = {}, nowMs = Date.now(), limit = 4 } = {}) {
  const rows = listOpen({ deps }).slice(0, limit);
  return rows.map((r) => {
    const ageH = Math.max(0, Math.round((nowMs - r.created_ts) / 3600000));
    return `   - [need #${r.id}] "${str(r.need).slice(0, 120)}" — named ${ageH}h ago by ${str(r.born_from || 'a run').slice(0, 60)}`;
  });
}

// Rehearsal-legal slug for a need-born run — the WHOLE slug capped to rehearsal's 40-char limit.
// Live failure (boots 90-96, 18/18 refusals): the cap was applied to the need-text suffix only, so
// `need-<id>-` + 40 chars of text overflowed SLUG_RE and every rehearse open died at the door. The
// id stays (uniqueness); the text gets whatever room remains.
function slugFor(id, needText) {
  const base = `need-${id}-${String(needText || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
  return base.slice(0, 40).replace(/-+$/, '') || `need-${id}`;
}

module.exports = { detect, record, listOpen, get, setStatus, setDiagnosis, harvest, suiteFor, slugFor, manifestLines };
