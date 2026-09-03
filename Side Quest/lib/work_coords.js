/*
 * lib/work_coords.js — DATABASE COORDINATES FOR THE WORK LANES (M5.7, 2026-08-08).
 *
 * Lucas: "when a report or an oped or a forecast or whatever is ordered everything should be fresh
 * hot and the model it goes to should be able to rapid fire through the database — but this should
 * be every action." The chat path has the keystone manifest; the WORK lanes (directed/enrich/
 * deepen passes, the doors' operator fallbacks, the metabolism) got their subject as TEXT plus a
 * tool list and burned operator steps discovering addresses the stores already hold.
 *
 * This module closes that at the ONE choke point every run passes through (_runCloudOperator):
 * cheap candidate extraction from the prompt's head (work-lane prompts name their subject early),
 * then CODE-ONLY resolution — zero model calls — against the local stores. Only HITS emit lines;
 * a candidate that resolves nowhere costs a few sync reads and prints nothing, so false candidates
 * are free. Deliberately NOT plumbed per call site: a plumbed subject drifts out of sync at any
 * site that forgets it (the lane.js lesson); ambient extraction at the choke point cannot.
 *
 * Sources (all local, all sync): civic_memberships (body addresses + live counts), documents
 * (doc#id titles, newest first), graph_entities (graph ids), absence (known open gaps — "we know
 * we DON'T know X" is a coordinate too).
 */
'use strict';

const str = (v) => (v == null ? '' : String(v));
let _db = null;
function db() { if (!_db) _db = require('./db'); return _db; }

// Words too generic to identify a subject on their own (mirrors civic_store's matcher).
const GENERIC = new Set(['the', 'and', 'for', 'his', 'her', 'their', 'current', 'every', 'each', 'this', 'that', 'parish', 'county', 'city', 'state', 'house', 'senate', 'council', 'police', 'jury', 'commission', 'board', 'district', 'report', 'research', 'verification', 'pass', 'target', 'documents', 'document'].map((w) => w));

/** candidatesFrom(text) → up to 4 likely subject strings from the prompt's HEAD (work-lane prompts
 * name their subject early). Quoted phrases first (they are deliberate), then capitalized runs of
 * 2+ words. Pure. */
function candidatesFrom(text) {
  const head = str(text).slice(0, 600);
  const out = [];
  const push = (s) => {
    const t = s.replace(/\s+/g, ' ').trim();
    if (t.length < 4 || t.length > 80) return;
    const words = t.toLowerCase().split(/\s+/);
    if (words.every((w) => GENERIC.has(w))) return;
    if (!out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  };
  for (const m of head.matchAll(/"([^"\n]{4,80})"/g)) push(m[1]);
  for (const m of head.matchAll(/(?:^|[\s(])([A-Z][A-Za-z'.-]+(?:\s+(?:of|the|for|and|St\.?|La)?\s*[A-Z][A-Za-z'.-]+){1,5})/g)) push(m[1]);
  return out.slice(0, 4);
}

// Distinctive words of a candidate (the match key against body_keys / titles).
function _sigWords(candidate) {
  return str(candidate).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !GENERIC.has(w));
}

// The newest 2 held documents whose TITLE carries every word. THE INDEX, NOT THE SCAN (freeze cut 7):
// `title LIKE ? AND title LIKE ? AND title LIKE ?` walked all 51k titles + a temp B-tree on every directed
// brief — 1.0–1.4s cold on p258–p260, the last named statement standing. documents_fts answers the same
// ask in ~3ms as prefix terms on its title column. The index is external-content, synced by a background
// beat behind a watermark (documents_fts.max_id), so a document landed since the last sync is NOT in it:
// the rows ABOVE the watermark still get the LIKE — bounded to those few — so recall stays exact (the
// fresh landing a run is about is often the newest row). No FTS yet → the plain LIKE, as before.
const _docStats = { fts: 0, tail: 0, like: 0 };   // per-process counters, for the smoke
function _docsTitled(words) {
  const D = db();
  const d = D.getDb();
  const ws = (words || []).filter(Boolean);
  if (!ws.length) return [];
  const likeSql = (extra) => `SELECT id, title, source, created_ts FROM documents WHERE ${ws.map(() => 'title LIKE ?').join(' AND ')}${extra} ORDER BY created_ts DESC LIMIT 2`;
  const likeArgs = ws.map((w) => `%${w}%`);
  let ready = false; try { ready = typeof D.documentsFtsReady === 'function' && D.documentsFtsReady(); } catch { ready = false; }
  if (!ready) { _docStats.like++; return d.prepare(likeSql('')).all(...likeArgs); }
  let wm = 0; try { wm = parseInt(D.getMeta('documents_fts.max_id') || '0', 10) || 0; } catch { wm = 0; }
  let rows = [];
  try {
    const match = ws.map((w) => `title:${String(w).replace(/[^a-z0-9]/gi, '')}*`).filter((t) => t.length > 7).join(' AND ');
    if (match) {
      rows = d.prepare(`SELECT d.id, d.title, d.source, d.created_ts FROM documents_fts f JOIN documents d ON d.id = f.rowid
                         WHERE documents_fts MATCH ? AND d.id <= ? ORDER BY d.created_ts DESC LIMIT 2`).all(match, wm);
      _docStats.fts++;
    }
  } catch { rows = []; }
  try { rows = rows.concat(d.prepare(likeSql(' AND id > ?')).all(...likeArgs, wm)); _docStats.tail++; } catch {}
  return rows.sort((a, b) => (b.created_ts || 0) - (a.created_ts || 0)).slice(0, 2);
}

/** coordBlock(text, {deps}) → a "DATABASE COORDINATES" block string for hits, or '' when nothing
 * resolves. Bounded (~12 lines). Fail-soft per source — a store error never blocks a run. */
function coordBlock(text, { now = Date.now() } = {}) {
  const cands = candidatesFrom(text);
  if (!cands.length) return '';
  const lines = [];
  let bodies = [];
  try { bodies = db().getDb().prepare(`SELECT body_key, COUNT(*) n FROM civic_memberships WHERE superseded_by IS NULL GROUP BY body_key`).all(); } catch {}
  for (const c of cands.slice(0, 4)) {
    const words = _sigWords(c);
    if (!words.length) continue;
    // civic bodies whose distinctive words all appear in the candidate (or vice versa)
    try {
      for (const b of bodies) {
        const bw = str(b.body_key).split(/\s+/).filter((w) => w.length > 2 && !GENERIC.has(w));
        if (!bw.length) continue;
        const cl = c.toLowerCase();
        if (bw.every((w) => cl.includes(w)) || words.every((w) => str(b.body_key).includes(w))) {
          lines.push(`- civic: "${b.body_key}" — ${b.n} live member row(s) in civic_memberships (query by body_key)`);
          if (lines.length >= 12) return _render(lines);
        }
      }
    } catch {}
    // held documents, newest first
    try {
      for (const d of _docsTitled(words.slice(0, 3))) {
        lines.push(`- doc#${d.id} "${str(d.title).slice(0, 80)}" [${d.source || 'held'}, ${Math.max(0, Math.round((now - d.created_ts) / 86400000))}d old]`);
        if (lines.length >= 12) return _render(lines);
      }
    } catch {}
    // graph entity address (the column is entity_type — `type` never existed, so this line never emitted)
    try {
      const g = db().getDb().prepare(`SELECT id, name, entity_type AS type FROM graph_entities WHERE name LIKE ? LIMIT 1`).get(`%${c}%`);
      if (g) lines.push(`- graph: ${g.type || 'entity'}#${g.id} "${str(g.name).slice(0, 60)}"`);
    } catch {}
    // known open gaps — a coordinate for what we DON'T hold. Direct table read: absence.openGaps
    // returns only TTL-EXPIRED gaps (its job is the re-attempt sweep); a FRESH miss is still a
    // known gap this run should not re-derive.
    try {
      // every row is an open gap by construction — recordFound DELETES (absence.js:144)
      const likeGap = words.slice(0, 2).map(() => `subject LIKE ?`).join(' AND ');
      const gp = db().getDb().prepare(`SELECT subject, predicate, attempts FROM absence WHERE ${likeGap} LIMIT 2`).all(...words.slice(0, 2).map((w) => `%${w}%`));
      for (const g of gp) lines.push(`- known-gap: ${str(g.predicate || 'fact')} of "${str(g.subject).slice(0, 60)}" (${g.attempts || 1} prior attempt(s))`);
    } catch {}
    if (lines.length >= 12) break;
  }
  return _render(lines);
}

function _render(lines) {
  if (!lines.length) return '';
  const uniq = [...new Set(lines)].slice(0, 12);
  return `\nDATABASE COORDINATES (verified addresses for this run's subjects — START HERE and dereference via localdb/echo/analyze_data before any searching; a known-gap line means we already know we lack it):\n${uniq.join('\n')}\n`;
}

/**
 * heldDataBlock(text, {budget}) — OPERATOR HELD-DATA PRE-INJECTION (deterministic-loops #1,
 * 2026-08-15; the single biggest measured lever, 1.8–3.7M tok/day). The pick ledger showed the
 * operator's dominant brief shape is "search knowledge graph for {place} council members" — and
 * the deepseek run then spent its gathering iterations REDISCOVERING rosters civic_memberships
 * already holds. This injects the ACTUAL held rows (not just addresses) at the same choke point
 * coordBlock rides, so gathering collapses into verification. Beat contract: the operator run
 * still happens — now processing held rosters instead of searching for them.
 *
 * BRIEF-SIZE BUDGET (the doc's "needs care"): total ≤ `budget` chars (default 2,400 ≈ 700 tok),
 * each roster line capped at 900 with a dereference pointer — a 4-body hit can never blow up the
 * context. Sync + local only (civic_store); Echo-side contacts stay a tool call. '' on no match,
 * so non-civic runs pay nothing. Fail-soft.
 */
function heldDataBlock(text, { budget = 2400 } = {}) {
  try {
    const civic = require('./civic_store');
    const hits = civic.heldRostersFor(str(text).slice(0, 600), { limit: 4 });
    if (!hits || !hits.length) return '';
    const lines = [];
    let used = 0;
    for (const h of hits) {
      let l = str(h.line);
      if (l.length > 900) l = l.slice(0, 900) + ` … (+more — dereference body_key "${h.bodyKey}" via civic query)`;
      if (used + l.length > budget) break;
      used += l.length;
      lines.push('- ' + l);
    }
    if (!lines.length) return '';
    return `\nHELD DATA (your own verified store ALREADY CONTAINS these rows — they are the primary source: work FROM them, verify or extend only the gaps, and do NOT re-search what is listed; a VACANT/CONFLICT marker is a real finding, repeat it as stated):\n${lines.join('\n')}\n`;
  } catch { return ''; }
}

module.exports = { candidatesFrom, coordBlock, heldDataBlock, _docsTitled, _docStats };
