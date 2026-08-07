/*
 * lib/recheck_queue.js — THE METABOLISM's worklist. PURE decision logic + a fail-soft sq.db edge.
 *
 * Lucas's north star (2026-08-07, [[program-end-state]]): an always-on program "always asking
 * questions, verifying and reverifying, testing and failing and retesting." The diagnosis of why
 * that never happened: every doubt-producer (stale absences, decayed edges, roster discrepancies,
 * cardinality conflicts, unsubstantiated claims) had its own starved lane, and the idle mind chose
 * work by LOTTERY, where "verify" competed with everything and lost (explore: 3 fires ever).
 *
 * This module is the cure's first half: ONE prioritized queue every producer feeds and one
 * consumer (the metabolism tick in main.js) drains — worklist-exhaustion, not lottery. The second
 * half is the FLOOR: the consumer runs on gemma4:31b-cloud (Lucas: per-compute pricing makes the
 * 31b nearly free; local was deliberately demoted to cold) on the interactive lane with its own
 * hourly cap — protected from the quota governor by construction, bounded by its own ceiling.
 *
 * Doctrine carried over from lib/absence.js: resolution is HONEST and cyclical. A re-check that
 * still finds nothing re-records the miss (TTL backoff) and closes the queue row — the absence's
 * own expiry re-enqueues it later. A re-check that FINDS the value closes the gap via
 * absence.recordFound. Nothing here asserts; the verification pass grounds through tools.
 */
'use strict';

const str = (v) => (v == null ? '' : String(v));
let _db = null;
function db() { if (!_db) _db = require('./db'); return _db; }

// Backoff for an unresolved recheck (distinct from the absence TTL, which governs re-ENQUEUE):
// 6h, 12h, 24h, 48h … capped at 7d — an item that keeps failing to verify slows down, never spins.
function backoffMs(attempts) { return Math.min(7 * 24 * 3600 * 1000, 6 * 3600 * 1000 * Math.pow(2, Math.max(0, attempts))); }

/** enqueue({kind, subject, detail?, priority?, dueTs?, bornFrom?}) → {id, existing} — one OPEN row
 * per (kind, subject); a re-enqueue of an open item raises priority and keeps the EARLIER due. */
function enqueue({ kind, subject, detail = null, priority = 5, dueTs = null, bornFrom = null, now = Date.now() } = {}) {
  const k = str(kind).trim(), s = str(subject).trim();
  if (!k || !s) return { ok: false, reason: 'kind and subject are required' };
  const due = dueTs == null ? now : dueTs;
  try {
    const d = db().getDb();
    const cur = d.prepare(`SELECT id, priority, due_ts FROM recheck_queue WHERE kind = ? AND subject = ? AND status = 'open'`).get(k, s);
    if (cur) {
      d.prepare('UPDATE recheck_queue SET priority = MAX(priority, ?), due_ts = MIN(due_ts, ?) WHERE id = ?').run(priority, due, cur.id);
      return { ok: true, id: cur.id, existing: true };
    }
    const info = d.prepare(
      `INSERT INTO recheck_queue (kind, subject, detail, priority, due_ts, born_from, created_ts) VALUES (?,?,?,?,?,?,?)`
    ).run(k, s, detail == null ? null : JSON.stringify(detail), priority, due, bornFrom, now);
    return { ok: true, id: info.lastInsertRowid, existing: false };
  } catch (e) { return { ok: false, reason: e.message }; }
}

/** The consumer's plate: open items past due, highest priority first, oldest due first. */
function due({ limit = 3, now = Date.now() } = {}) {
  try {
    return db().getDb().prepare(
      `SELECT * FROM recheck_queue WHERE status = 'open' AND due_ts <= ? ORDER BY priority DESC, due_ts ASC LIMIT ?`
    ).all(now, Math.max(1, limit)).map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
  } catch { return []; }
}

function complete(id, { outcome = '', now = Date.now() } = {}) {
  try { db().getDb().prepare(`UPDATE recheck_queue SET status = 'done', outcome = ?, last_attempt_ts = ?, attempts = attempts + 1 WHERE id = ?`).run(str(outcome).slice(0, 500), now, id); return true; }
  catch { return false; }
}

function defer(id, { now = Date.now() } = {}) {
  try {
    const d = db().getDb();
    const cur = d.prepare('SELECT attempts FROM recheck_queue WHERE id = ?').get(id);
    const n = (cur ? cur.attempts : 0) + 1;
    d.prepare(`UPDATE recheck_queue SET attempts = ?, last_attempt_ts = ?, due_ts = ? WHERE id = ?`).run(n, now, now + backoffMs(n), id);
    return true;
  } catch { return false; }
}

function stats() {
  try {
    const d = db().getDb();
    const open = d.prepare(`SELECT COUNT(*) n FROM recheck_queue WHERE status = 'open'`).get().n;
    const dueNow = d.prepare(`SELECT COUNT(*) n FROM recheck_queue WHERE status = 'open' AND due_ts <= ?`).get(Date.now()).n;
    const byKind = d.prepare(`SELECT kind, COUNT(*) n FROM recheck_queue WHERE status = 'open' GROUP BY kind`).all();
    return { open, dueNow, byKind };
  } catch { return { open: 0, dueNow: 0, byKind: [] }; }
}

// ── PRODUCER: stale absences → the queue (the ask-again cycle) ──────────────────────────────────
// An absence whose TTL expired is due for a genuine re-attempt. Enqueued (deduped) — the consumer's
// re-check then either closes the gap (recordFound) or re-records the miss, whose new TTL re-arms
// this sweep later. The cycle IS the "verifying and reverifying" Lucas named.
function sweepAbsences({ limit = 20, now = Date.now() } = {}) {
  let queued = 0;
  try {
    const absence = require('./absence');
    const gaps = absence.openGaps({ limit: 200, now });
    for (const g of gaps) {
      if (absence.isFresh(g, now)) continue;                       // TTL not expired → not due yet
      const r = enqueue({ kind: 'absence', subject: g.subject, detail: { predicate: g.predicate, attempts: g.attempts }, priority: 4, bornFrom: 'absence-ttl', now });
      if (r.ok && !r.existing) queued++;
      if (queued >= limit) break;
    }
  } catch { /* fail-soft: no sweep, no queue rows */ }
  return { queued };
}

// ── the verification pass, per kind (PURE prompt builders + outcome parsing) ────────────────────
// The pass must end in ONE machine-readable verdict line so the consumer never guesses:
//   RESOLVED: <the found fact + its source>     → gap closed / discrepancy settled
//   STILL-UNKNOWN: <what was checked>           → honest miss, re-recorded, cycle continues
//   (anything else / no answer)                 → deferred with backoff
const VERDICT_CONTRACT = `End your answer with EXACTLY ONE line starting "RESOLVED:" (you found and grounded it — state the fact and its source inline) or "STILL-UNKNOWN:" (a genuine attempt found nothing — name what you checked). A claim without a source is not RESOLVED.`;

function buildPrompt(item) {
  const d = item.detail || {};
  switch (item.kind) {
    case 'absence':
      return `VERIFICATION PASS — a known gap, due for re-check. We previously looked for the ${d.predicate || 'missing fact'} of "${item.subject}" and did not find it (${d.attempts || 1} prior attempt(s)). Try again now with your tools (echo / localdb / web as needed) — sources may have changed since. ${VERDICT_CONTRACT}`;
    case 'discrepancy':
      return `VERIFICATION PASS — a flagged discrepancy: ${item.subject}. Detail: ${JSON.stringify(d).slice(0, 400)}. Check the OFFICIAL source for this seat/body and one independent source; state what is actually true now. ${VERDICT_CONTRACT}`;
    case 'vacancy':
      return `VERIFICATION PASS — a seat with no feed row (possible vacancy): ${item.subject}. Confirm against the official body roster + one news source: is the seat vacant, and if so since when / any special election scheduled? ${VERDICT_CONTRACT}`;
    case 'cardinality-conflict':
      return `VERIFICATION PASS — two sources disagree on the seat count of "${item.subject}": ${JSON.stringify(d).slice(0, 300)}. Determine the current correct count from the official source (a resize is possible). ${VERDICT_CONTRACT}`;
    default:
      return `VERIFICATION PASS — re-verify: ${item.subject} (${item.kind}). ${JSON.stringify(d).slice(0, 300)}. ${VERDICT_CONTRACT}`;
  }
}

/** parseVerdict(ans) → {verdict:'resolved'|'unknown'|'inconclusive', line} — pure. */
function parseVerdict(ans) {
  const t = str(ans);
  const m = t.match(/^\s*(RESOLVED|STILL-UNKNOWN):\s*(.*)$/im);
  if (!m) return { verdict: 'inconclusive', line: '' };
  return { verdict: m[1].toUpperCase() === 'RESOLVED' ? 'resolved' : 'unknown', line: m[2].slice(0, 400) };
}

/** applyOutcome(item, ans) — route the verdict: close/re-arm/defer. Returns what it did. */
function applyOutcome(item, ans, { now = Date.now() } = {}) {
  const v = parseVerdict(ans);
  if (v.verdict === 'resolved') {
    if (item.kind === 'absence') {
      try { require('./absence').recordFound(item.subject, (item.detail || {}).predicate || ''); } catch {}
    }
    complete(item.id, { outcome: `RESOLVED: ${v.line}`, now });
    // ALIVENESS: a closed doubt is worth a sentence to Lucas — the metabolism working is only felt
    // if its wins surface. One line through the unprompted door (the heartbeat delivers when he's
    // present); misses and deferrals stay quiet — restlessness should hum, not nag.
    try {
      db().insertInbound({ tabUrl: 'note://metabolism', speaker: 'system', source: 'metabolism',
        text: `metabolism: re-checked ${item.kind} "${str(item.subject).slice(0, 80)}" — ${v.line.slice(0, 200)}` });
    } catch { /* surfacing is best-effort */ }
    return { action: 'resolved', line: v.line };
  }
  if (v.verdict === 'unknown') {
    if (item.kind === 'absence') {
      // an honest miss re-arms the absence TTL; its next expiry re-enqueues — the cycle.
      try { require('./absence').recordMiss(item.subject, (item.detail || {}).predicate || '', { now }); } catch {}
    }
    complete(item.id, { outcome: `STILL-UNKNOWN: ${v.line}`, now });
    return { action: 'still-unknown', line: v.line };
  }
  defer(item.id, { now });
  return { action: 'deferred' };
}

module.exports = { enqueue, due, complete, defer, stats, sweepAbsences, buildPrompt, parseVerdict, applyOutcome, backoffMs };
