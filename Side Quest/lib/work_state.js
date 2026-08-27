'use strict';
/*
 * lib/work_state.js — THE WORK-STATE VECTOR (W5 Slice 0, 2026-08-19 live-test run 2).
 *
 * The run-2 root disease was SAY-DO DECOUPLING: the reply layer ASSERTED work-states ("records
 * indicate it's still pending", "pulling it now", "due tomorrow morning") that no measured source
 * backed — the false statuses were composed, not read. This module is the measured source: ONE
 * fail-soft snapshot of what work actually exists right now — open delivery promises (recheck_queue),
 * recent directed foci (meta focus.*), and the live activity stamps — plus pure probes the say-truth
 * gate (metacognition.verifyWorkStateClaims) checks claims against, and an honest renderStatus() that
 * FORMATS measured values instead of letting the model re-imagine them.
 *
 * Doctrine (the smoothing firewall, docs/CONSCIOUSNESS_THEORIES_AS_SMOOTHING_2026-08-18.md): this
 * module only READS and RENDERS measurements — it never asserts, never fabricates a record, and every
 * edge fails soft to "unknown" (probes fail OPEN at the gate, so a read hiccup can never false-scold).
 *
 * Pure parts (matching, rendering) take an injected snapshot — no db — so the smoke covers them
 * offline; snapshot() itself is the one fail-soft db edge. Run: scripts/smoke_work_state.js
 */

const str = (v) => (v == null ? '' : String(v));

// Tokenize a subject/anchor for matching: lowercase word tokens ≥3 chars, minus glue words.
const _TOK_STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'those', 'these', 'you', 'your', 'our', 'her', 'his', 'its', 'are', 'was', 'were', 'been', 'have', 'has', 'had', 'will', 'would', 'into', 'onto', 'about', 'still', 'pending', 'report', 'briefing', 'list', 'sheet', 'dossier', 'document', 'draft', 'summary', 'task', 'project']);
function _tokens(s) {
  const out = [];
  for (const m of str(s).toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || []) {
    if (_TOK_STOP.has(m) || out.includes(m)) continue;
    out.push(m);
  }
  return out;
}

/**
 * snapshot() — the measured work-state, read fail-soft from the live stores.
 * { ts, promises:[{id, subject, deliverable, topic, bornTs}], foci:[{id, kind, subject, targets,
 *   covered, file}], lastGatherTs, lastExternalGatherTs, lastCanvasWriteTs }
 * Every section degrades independently: a read error yields an empty section, never a throw.
 */
function snapshot({ maxFoci = 12, now = Date.now() } = {}) {
  const snap = { ts: now, promises: [], foci: [], lastGatherTs: 0, lastExternalGatherTs: 0, lastCanvasWriteTs: 0 };
  // Open delivery promises — the ledger of work she has SAID she'd do (recheck_queue kind='promise').
  try {
    const d = require('./db').getDb();
    const rows = d.prepare(`SELECT id, subject, detail, created_ts FROM recheck_queue WHERE status = 'open' AND kind = 'promise' ORDER BY created_ts DESC LIMIT 40`).all();
    for (const r of rows) {
      let det = null; try { det = r.detail ? JSON.parse(r.detail) : null; } catch {}
      snap.promises.push({ id: r.id, subject: str(r.subject), deliverable: str(det && det.deliverable), topic: str(det && det.topic), bornTs: r.created_ts || 0 });
    }
  } catch {}
  // Recent directed foci — what the background machinery is actually holding (meta focus.<id>.*).
  try {
    const db = require('./db');
    const keys = (db.getMetaKeysLike ? db.getMetaKeysLike('focus.%.plan') : []) || [];
    const ids = [...new Set(keys.map((k) => parseInt(String(k).split('.')[1], 10)).filter((n) => Number.isFinite(n)))].sort((a, b) => b - a).slice(0, maxFoci);
    for (const id of ids) {
      const f = { id, kind: '', subject: '', targets: [], covered: [], file: '' };
      try { f.kind = str(db.getMeta(`focus.${id}.kind`)); } catch {}
      try { f.file = str(db.getMeta(`focus.${id}.file`)); } catch {}
      try { const p = JSON.parse(db.getMeta(`focus.${id}.plan`) || '{}'); f.subject = str(p.objective).slice(0, 200); } catch {}
      try { f.targets = JSON.parse(db.getMeta(`focus.${id}.intended_targets`) || '[]').slice(0, 20).map(str); } catch {}
      try { f.covered = JSON.parse(db.getMeta(`focus.${id}.covered`) || db.getMeta(`focus.${id}.topical_covered`) || '[]').slice(0, 20).map(str); } catch {}
      snap.foci.push(f);
    }
  } catch {}
  // Live activity stamps — "is anything actually running/reading right now."
  try { snap.lastGatherTs = require('./echo_suit').lastGatherTs() || 0; } catch {}
  try { snap.lastExternalGatherTs = require('./echo_suit').lastExternalGatherTs() || 0; } catch {}
  try { snap.lastCanvasWriteTs = require('./canvas_docs').lastWriteTs() || 0; } catch {}
  // Background schedulers (F10-class, 2026-08-27): the api-bulk backfill was invisible to her
  // introspection — a "did the backfill run?" ask found no record and she asserted "no such pass
  // registered" while the scheduler was mid-drain. One measured row per configured job.
  try { snap.bulk = require('./api_bulk').standing(); } catch { snap.bulk = []; }
  // The site-sweep walker (2026-08-27): an active/recent whole-site sweep is real background work —
  // a whole-plate status ask must see it, or the model composes its absence (the F10 disease).
  try { snap.sweep = require('./site_crawler').standing(); } catch { snap.sweep = null; }
  // Self-diagnostic standing (census C5, 2026-08-27): the needs ledger and the last audit verdict
  // were invisible to every status surface — the antifab reflex denies what no door can see.
  try {
    snap.needs = require('./db').getDb().prepare('SELECT status, COUNT(*) n FROM capability_needs GROUP BY status').all()
      .reduce((a, r) => { a[r.status] = r.n; return a; }, {});
  } catch { snap.needs = null; }
  try { snap.audit = JSON.parse(require('./db').getMeta('audit.last_report') || 'null'); } catch { snap.audit = null; }
  return snap;
}

/**
 * pendingRecordFor(anchors, snap) — PURE. Does ANY measured record (an open promise, a focus subject/
 * target/file) share a token with the claim's anchors? Generous by design (any hit → true): the gate
 * only scolds a pending-claim when NOTHING anywhere matches — under-scolding beats a false correction.
 */
function pendingRecordFor(anchors, snap) {
  const want = [];
  for (const a of Array.isArray(anchors) ? anchors : []) for (const t of _tokens(a)) if (!want.includes(t)) want.push(t);
  if (!want.length || !snap) return true;   // nothing checkable → fail open
  const hay = [];
  for (const p of snap.promises || []) hay.push(p.subject, p.deliverable, p.topic);
  for (const f of snap.foci || []) { hay.push(f.subject, f.file); for (const t of f.targets || []) hay.push(t); }
  for (const b of snap.bulk || []) hay.push(b.id, b.state, 'backfill legiscan bulk');   // scheduler jobs ground backfill claims (F10-class)
  if (snap.sweep) hay.push(snap.sweep.host, 'site sweep crawl');   // the walker grounds sweep claims the same way
  const flat = hay.map((s) => str(s).toLowerCase()).join(' \n ');
  return want.some((t) => flat.includes(t));
}

/** liveWorkNow(turnStartTs, snap) — PURE. Is anything measurably in motion for/around this turn? */
function liveWorkNow(turnStartTs, snap, { graceMs = 10 * 60 * 1000 } = {}) {
  if (!snap) return true;   // fail open
  const t0 = turnStartTs || 0;
  if (!t0) return true;
  if ((snap.lastGatherTs || 0) >= t0 || (snap.lastExternalGatherTs || 0) >= t0 || (snap.lastCanvasWriteTs || 0) >= t0) return true;
  return (snap.promises || []).some((p) => (p.bornTs || 0) >= t0 - graceMs);
}

/**
 * renderStatus(snap) — PURE. An honest, compact status the say layer can RENDER instead of compose:
 * only measured values, ages spelled out, and an explicit "nothing measured" when the vector is empty.
 */
function renderStatus(snap, { now = Date.now() } = {}) {
  if (!snap) return 'Work-state: unavailable this tick.';
  const age = (ts) => {
    if (!ts) return 'never';
    const m = Math.max(0, Math.round((now - ts) / 60000));
    return m < 1 ? 'under a minute ago' : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
  };
  const lines = [];
  const pr = snap.promises || [];
  lines.push(pr.length
    ? `Open delivery promises (${pr.length}): ${pr.slice(0, 5).map((p) => p.deliverable || p.subject).filter(Boolean).join('; ')}${pr.length > 5 ? '; …' : ''}`
    : 'Open delivery promises: none on the ledger.');
  const foci = (snap.foci || []).slice(0, 5);
  if (foci.length) {
    for (const f of foci) {
      const covered = (f.covered || []).length;
      const total = (f.targets || []).length;
      const subj = (f.subject || '').slice(0, 90) || '(no recorded objective)';
      lines.push(`Focus #${f.id}${f.kind ? ` [${f.kind}]` : ''}: ${subj}${total ? ` — ${covered}/${total} targets covered` : covered ? ` — ${covered} item(s) covered` : ''}`);
    }
  } else lines.push('Directed foci: none recorded recently.');
  lines.push(`Last tool read ${age(snap.lastGatherTs)}; last canvas write ${age(snap.lastCanvasWriteTs)}.`);
  const bulk = snap.bulk || [];
  if (bulk.length) {
    lines.push(`Background backfill (api-bulk scheduler): ${bulk.map((b) => `${b.state || b.id} ${b.records} record(s)${b.newestTs ? `, newest landed ${age(b.newestTs)}` : ''}`).join(' · ')}.`);
  }
  if (snap.sweep && snap.sweep.status === 'active') {
    lines.push(`Site sweep: ${snap.sweep.host} — ${snap.sweep.done}/${snap.sweep.total} pages walked (${snap.sweep.fetched} fetched, ${snap.sweep.reused} reused, ${snap.sweep.docs} docs landed).`);
  }
  if (snap.needs && (snap.needs.open || snap.needs.proposed || snap.needs.blocked_external)) {
    lines.push(`Self-diagnostics: ${snap.needs.open || 0} open need(s)${snap.needs.proposed ? `, ${snap.needs.proposed} PROPOSED awaiting the builder` : ''}${snap.needs.blocked_external ? `, ${snap.needs.blocked_external} blocked on Lucas` : ''}.`);
  }
  return lines.join('\n');
}

// F29 (saturation run 3, 2026-08-20): the measured-status lead only lived behind the POLL-TRACK door
// (main.js `ans.kind === 'status'`), so fresh status phrasings ("Where do things stand on everything
// I've got you working on?" / "Run me through your open items — honest ledger.") composed a ledger
// from raw tool reads — template repeats, and one turn acked "pulling the honest ledger now" and
// delivered nothing. This probe is the GENERAL door: a whole-plate work-status question, detected at
// the same tier as the self-learn/self-activity doors. Precision notes: bare "status"/"working on"
// stay out (the activity poll owns present-activity; specific-thing status asks keep their lanes) —
// every alternation here carries a whole-plate cue (everything / open items / things stand / plate).
const _WORK_STATUS_RE = /\bwhere (?:do|does) (?:things|we|everything|it all|stuff) stand\b|\bopen (?:items|orders|tasks|threads|work)\b|\bwhat(?:'s| is) (?:still )?(?:open|outstanding|on your plate)\b|\brun me through (?:your|the) (?:open|current|active|outstanding)\b|\beverything (?:i'?ve|we'?ve) got you (?:work|going|running)\w*\b|\bhonest ledger\b|\bwhat do you (?:still )?owe me\b|\bwhat(?:'s| is) (?:left|remaining) (?:on|in) (?:your|the) (?:queue|plate|list|ledger)\b/i;
function isWorkStatusQuestion(text) { return _WORK_STATUS_RE.test(String(text || '')); }

module.exports = { snapshot, pendingRecordFor, liveWorkNow, renderStatus, isWorkStatusQuestion, _tokens };
