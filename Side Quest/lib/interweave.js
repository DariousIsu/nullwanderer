/**
 * lib/interweave.js — M4.2 INTERSECTION PASS (docs/BUILD_PLAN_2026-08-03.md, Interweave).
 *
 * The join half of the interweave: M4.1's touchpoints record WHAT each completed product touched;
 * this pass asks WHO ELSE CARES. A fresh touchpoint (an entity some product just touched) that also
 * lives in ANOTHER active stream's concept set — his open threads, her open inquiries, a research
 * run's covered index, an active interest — is a cross-project leverage candidate: work done over
 * THERE just surfaced material relevant HERE. Candidates ride the autonomy manifest; the decider
 * acts through the existing `build` door (a small cited leverage note). Filing to the receiving
 * track + the morning package is M4.3.
 *
 * Judgement lives HERE, not in the stamp — so this is where the noise guards are:
 *   HUB GUARD    an entity claimed by too many streams is generic ("Louisiana"), not leverage;
 *   SELF-JOIN    a stream never receives leverage from its own touch;
 *   SHORT NAMES  a normalized name under 4 chars can't text-match honestly ("AI" lives everywhere);
 *   SURFACING BRAKE  a candidate pair surfaces at most once per 24h (meta ledger) — the phantom-
 *     meeting churn (2026-08-05) showed the decider re-picks whatever the manifest keeps shouting.
 *
 * Pure + deps-injected; every source independently guarded (a missing table drops that set, never
 * the pass). Offline-smokeable: scripts/smoke_interweave.js.
 */
'use strict';

const HUB_CAP = 6;                       // fresh streams + matching sets beyond this = generic entity
const BRAKE_KEY = 'interweave.surfaced'; // { "<entityKey>::<toKey>": ts } — one surfacing per pair per day
const BRAKE_MS = 24 * 3600 * 1000;
const MAX_CANDIDATES = 5;                // manifest lines are a decision surface, not a dump

function _norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim(); }

// ---- the RECEIVING side: concept sets of active streams -------------------
// Each set: { kind, key, label, keys?: Set<entityKey>, text?: normalized } — membership is exact
// key-membership when we have an index (focus covered), text containment otherwise.
function conceptSets({ db = null, deps = {} } = {}) {
  const dbm = db || require('./db');
  let d = null; try { d = dbm.getDb(); } catch { return []; }
  const sets = [];
  const grab = (label, fn) => { try { fn(); } catch (e) { try { console.error(`[interweave] set source failed (${label}):`, e.message); } catch {} } };

  grab('threads', () => {
    const otLib = deps.openThreads || require('./open_threads');
    for (const r of d.prepare("SELECT id, content FROM open_threads WHERE status IN ('active','pending')").all()) {
      if (otLib.isAutonomousMapping && otLib.isAutonomousMapping(r.content)) continue;   // the 59-thread sweep is not a project
      sets.push({ kind: 'thread', key: `thread:${r.id}`, label: String(r.content || '').replace(/\s+/g, ' ').slice(0, 120), text: _norm(r.content) });
    }
  });

  grab('inquiries', () => {
    const rows = (deps.inquiry || require('./inquiry')).listActive({ deps: { db: dbm } }) || [];
    for (const r of rows) sets.push({ kind: 'inquiry', key: `inquiry:${r.id}`, label: String(r.question || '').replace(/\s+/g, ' ').slice(0, 120), text: _norm(r.question) });
  });

  grab('focuses', () => {
    const tp = require('./touchpoint');
    // a KEY RANGE, not LIKE (freeze cut 7): the case-insensitive LIKE scanned all 10.7k meta rows with
    // their values (137ms, inside the manifest's 0.8s interweave section); the range rides the key index
    // and the regex below keeps the exact `.covered` selection.
    for (const r of d.prepare("SELECT key, value FROM meta WHERE key >= 'focus.' AND key < 'focus/'").all()) {
      const id = (String(r.key).match(/^focus\.(\d+)\.covered$/) || [])[1];
      if (!id) continue;
      let covered = []; try { covered = JSON.parse(r.value) || []; } catch {}
      if (!Array.isArray(covered) || !covered.length) continue;
      let label = `research run #${id}`;
      try { const t = d.prepare('SELECT content FROM open_threads WHERE id = ?').get(parseInt(id, 10)); if (t && t.content) label = String(t.content).replace(/\s+/g, ' ').slice(0, 120); } catch {}
      const keys = new Set(covered.map((n) => tp.keyOf(n)).filter(Boolean));
      if (keys.size) sets.push({ kind: 'focus', key: `focus:${id}`, label, keys });
    }
  });

  grab('interests', () => {
    for (const r of d.prepare("SELECT id, topic FROM interests WHERE status = 'active'").all()) {
      sets.push({ kind: 'interest', key: `interest:${r.id}`, label: String(r.topic || '').slice(0, 120), text: _norm(r.topic) });
    }
  });

  return sets;
}

function _member(set, entityKey, entityName) {
  if (set.keys) return set.keys.has(entityKey);
  const n = _norm(entityName);
  if (n.length < 4) return false;                        // "AI"/"US" would match every text set
  return !!set.text && set.text.includes(n);
}

// ---- the JOIN ---------------------------------------------------------------
// fresh: touchpoint.fresh() groups — [{ entity, entity_key, entity_type, streams:[{kind,key,label,ref,ts}] }]
// Returns candidates: { entity, entityKey, entityType, from (freshest touching stream), to (receiving set) }.
function intersect({ fresh = [], sets = [], brake = {}, now = Date.now() } = {}) {
  const out = [];
  for (const f of (fresh || [])) {
    if (!f || !f.entity_key || !Array.isArray(f.streams) || !f.streams.length) continue;
    const own = new Set(f.streams.map((s) => s.key));
    const matches = (sets || []).filter((s) => !own.has(s.key) && _member(s, f.entity_key, f.entity));
    if (!matches.length) continue;
    if (f.streams.length + matches.length > HUB_CAP) continue;         // generic hub — noise, not leverage
    const from = f.streams.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0))[0];
    for (const to of matches) {
      const bk = `${f.entity_key}::${to.key}`;
      const last = brake[bk] || 0;
      if (now - last < BRAKE_MS) continue;                             // surfaced within a day — don't shout
      out.push({ entity: f.entity, entityKey: f.entity_key, entityType: f.entity_type || null, from, to, brakeKey: bk });
    }
  }
  // freshest touch first; the manifest takes the top few
  return out.sort((a, b) => ((b.from && b.from.ts) || 0) - ((a.from && a.from.ts) || 0));
}

// ---- manifest surface --------------------------------------------------------
// Computes the pass end-to-end and stamps the surfacing brake for the lines it RETURNS (a candidate
// shown but not acted on comes back tomorrow; one never shown is not braked). Fail-open → [].
function manifestLines({ db = null, deps = {}, now = Date.now(), sinceMs = 24 * 3600 * 1000, limit = MAX_CANDIDATES } = {}) {
  try {
    const dbm = db || require('./db');
    const tp = deps.touchpoint || require('./touchpoint');
    const fresh = tp.fresh({ sinceMs, now });
    if (!fresh.length) return [];
    const sets = (deps.conceptSets || conceptSets)({ db: dbm, deps });
    if (!sets.length) return [];
    let brake = {}; try { brake = JSON.parse(dbm.getMeta(BRAKE_KEY) || '{}') || {}; } catch {}
    const cands = intersect({ fresh, sets, brake, now }).slice(0, limit);
    if (!cands.length) return [];
    for (const c of cands) brake[c.brakeKey] = now;                    // brake only what we actually surface
    for (const k of Object.keys(brake)) if (now - brake[k] > 7 * BRAKE_MS) delete brake[k];   // ledger hygiene
    try { dbm.setMeta(BRAKE_KEY, JSON.stringify(brake)); } catch {}
    return cands.map((c) =>
      `   - "${c.entity}"${c.entityType ? ` (${c.entityType})` : ''} — fresh from ${c.from.kind} "${String(c.from.label || c.from.key).slice(0, 70)}" ALSO lives in your ${c.to.kind} "${String(c.to.label || c.to.key).slice(0, 70)}" [${c.to.key}] — a small cited note on what the new touch adds to that ${c.to.kind} is real leverage`);
  } catch { return []; }
}

// ---- M4.3: the leverage note reaches its RECEIVER ---------------------------
// A build acting on an intersection carries the receiving stream token in its target (the manifest
// line embeds it, DECISION_WANT instructs it forward). parseReceiver recovers it; fileLeverageNote
// routes the finished note to the receiving stream's OWN trail + surfaces it through the inbound
// door (the same unprompted channel email arrivals ride — the heartbeat delivers it when Lucas is
// next present). Fail-open: a filing failure never un-lands the note (it already lives on disk +
// doc_store); it just doesn't reach the receiver's trail.
const RECEIVER_RE = /\[(thread|inquiry|focus|interest):(\d+)\]/i;

function parseReceiver(text) {
  const m = RECEIVER_RE.exec(String(text || ''));
  if (!m) return null;
  return { kind: m[1].toLowerCase(), id: parseInt(m[2], 10), key: `${m[1].toLowerCase()}:${m[2]}` };
}

function fileLeverageNote({ receiver, artifactPath, gist = '', deps = {}, now = Date.now() } = {}) {
  if (!receiver || !artifactPath) return { filed: false, how: 'no-receiver-or-artifact' };
  const dbm = deps.db || require('./db');
  const g = String(gist || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const note = `Cross-project leverage note (interweave): ${artifactPath}${g ? ` — ${g}` : ''}`;
  let filed = false, how = 'unsupported';
  try {
    if (receiver.kind === 'thread' || receiver.kind === 'focus') {          // a focus IS an open_threads row
      filed = !!dbm.touchOpenThread(receiver.id, note);
      how = 'thread-progress-note';
    } else if (receiver.kind === 'inquiry') {
      filed = !!(deps.inquiry || require('./inquiry')).addEvidence(receiver.id, { gist: g || `leverage note: ${artifactPath}`, cite: artifactPath }, { deps: { db: dbm }, nowMs: now });
      how = 'inquiry-evidence';
    } else {
      how = `unsupported-receiver:${receiver.kind}`;                        // interest: no trail to file to (v1, honest)
    }
  } catch (e) { try { console.error('[interweave] filing failed:', e.message); } catch {} }
  // Surface to Lucas through the inbound door regardless of trail-filing (the note EXISTS either way).
  let surfaced = false;
  try {
    dbm.insertInbound({ tabUrl: 'interweave', speaker: 'zoe', text: `I built a cross-project leverage note for your ${receiver.kind} — ${artifactPath}${g ? `: ${g}` : ''}`, source: 'interweave' });
    surfaced = true;
  } catch {}
  return { filed, how, surfaced };
}

module.exports = { conceptSets, intersect, manifestLines, parseReceiver, fileLeverageNote, HUB_CAP, BRAKE_KEY, BRAKE_MS, MAX_CANDIDATES };
