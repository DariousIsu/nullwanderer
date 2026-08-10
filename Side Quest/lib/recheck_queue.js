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

/** Open items of a given KIND, past due, oldest first. Used by the delivery path to surface promises
 *  (which are excluded from the verification drain). */
function openByKind({ kind, limit = 1, now = Date.now() } = {}) {
  try {
    return db().getDb().prepare(
      `SELECT * FROM recheck_queue WHERE status = 'open' AND kind = ? AND due_ts <= ? ORDER BY due_ts ASC LIMIT ?`
    ).all(str(kind), now, Math.max(1, limit)).map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
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

// ── STRUCTURED ROSTER CAPTURE (2026-08-08, "a plan to fill in the blanks") ──────────────────────
// A prose RESOLVED closes the gap but lands NOTHING structured — the doc's next fill would still
// see an empty store. When the gap is roster-shaped, the pass also emits machine-readable member
// lines and applyOutcome records them via civic_store.recordRoster, so a resolve GROWS the store
// the next held-roster injection reads. Deterministic contract on model output — the sanctioned
// place for parsing.
const ROSTER_CONTRACT = `Because this gap is a roster/membership: AFTER the verdict line, also output ONE line per verified member, each starting "ROSTER: " — format "ROSTER: <full name> | <role or Member>". Only members verified from the source; no ROSTER lines if you could not verify names.`;
function _rosterShaped(predicate) { return /\b(officeholders?|rosters?|members?(?:hip)?|jur(?:y|ors?)|council|commission(?:ers?)?|board)\b/i.test(str(predicate)); }

/** parseRoster(ans) → [{personName, role}] — pure; empty when no ROSTER lines. */
function parseRoster(ans) {
  const out = [];
  for (const line of str(ans).split('\n')) {
    const m = line.match(/^\s*ROSTER:\s*([^|]{2,80}?)\s*(?:\|\s*(.{0,60}))?$/);
    if (!m) continue;
    const personName = m[1].trim();
    if (!personName || /^(none|n\/a|unknown)$/i.test(personName)) continue;
    out.push({ personName, role: (m[2] || 'Member').trim() || 'Member' });
  }
  return out;
}

// What we ALREADY HOLD on a subject — injected into every verification prompt so the pass starts
// from the database, not the open web (Lucas, 2026-08-08: "she has already done these searches
// hundreds of times, all of this information should already be in her database somewhere").
// Measured before this: the metabolism re-fetched appj.org (21 prior visits) for a subject with
// 465 parish documents already in the store. Fail-soft: no hits → no section, the pass proceeds.
function heldContext(subject, { limit = 3 } = {}) {
  try {
    const toks = (str(subject).toLowerCase().match(/[a-z][a-z0-9'-]{3,}/g) || []).slice(0, 5);
    if (!toks.length) return '';
    const like = toks.map(() => `(title LIKE ? OR body LIKE ?)`).join(' AND ');
    const params = []; for (const w of toks) params.push(`%${w}%`, `%${w}%`);
    const rows = db().getDb().prepare(
      `SELECT id, title, source, created_ts FROM documents WHERE ${like} ORDER BY created_ts DESC LIMIT ?`
    ).all(...params, limit);
    if (!rows.length) return '';
    const lines = rows.map((r) => `- doc#${r.id} [${r.source || 'held'}] "${str(r.title).slice(0, 90)}" (${Math.round((Date.now() - r.created_ts) / 86400000)}d old — read it with your localdb/doc tools)`);
    return `\nALREADY HELD on this subject — CHECK THESE FIRST, they may already answer:\n${lines.join('\n')}\n`;
  } catch { return ''; }
}

// The database-first order every pass follows: we have swept these subjects for weeks; the answer
// is usually already landed. The web is the LAST resort, not the reflex.
const LOCAL_FIRST = `Work DATABASE-FIRST: (1) the ALREADY-HELD docs above if any, (2) echo/localdb/recall searches of our own stores, (3) only if the held stores cannot answer, the web — and prefer pages our site map has not covered. A held document that answers IS a source: cite it as doc#N.`;

function buildPrompt(item) {
  const d = item.detail || {};
  const held = heldContext(item.subject);
  switch (item.kind) {
    case 'absence': {
      // doc-fill items carry their doc — "Acadia Parish" needs the doc's context to be findable.
      const docCtx = d.doc ? ` (a pending entry in the doc "${d.doc}")` : '';
      const rosterCtx = _rosterShaped(d.predicate) ? ` ${ROSTER_CONTRACT}` : '';
      return `VERIFICATION PASS — a known gap, due for re-check. We previously looked for the ${d.predicate || 'missing fact'} of "${item.subject}"${docCtx} and did not find it (${d.attempts || 1} prior attempt(s)).${held}${LOCAL_FIRST} ${VERDICT_CONTRACT}${rosterCtx}`;
    }
    case 'discrepancy':
      return `VERIFICATION PASS — a flagged discrepancy: ${item.subject}. Detail: ${JSON.stringify(d).slice(0, 400)}.${held}${LOCAL_FIRST} Then check the OFFICIAL source for this seat/body and one independent source; state what is actually true now. ${VERDICT_CONTRACT}`;
    case 'vacancy':
      return `VERIFICATION PASS — a seat with no feed row (possible vacancy): ${item.subject}.${held}Confirm against the official body roster + one news source: is the seat vacant, and if so since when / any special election scheduled? ${VERDICT_CONTRACT}`;
    case 'cardinality-conflict':
      return `VERIFICATION PASS — two sources disagree on the seat count of "${item.subject}": ${JSON.stringify(d).slice(0, 300)}.${held}Determine the current correct count from the official source (a resize is possible). ${VERDICT_CONTRACT}`;
    default:
      return `VERIFICATION PASS — re-verify: ${item.subject} (${item.kind}). ${JSON.stringify(d).slice(0, 300)}.${held}${LOCAL_FIRST} ${VERDICT_CONTRACT}`;
  }
}

// ── M9.3 — BATCHED SMALL VERIFIES (2026-08-08): several one-fact gaps share ONE operator pass ───
// Throughput is bounded by PASSES (the spend unit), not gaps — so batching raises gap throughput
// without touching the hourly cap. Only kinds whose outcome is a bare verdict batch safely:
// open-questions and NON-roster absences. Roster absences (structured member capture), plus
// discrepancy/vacancy/cardinality (per-subject instructions), stay solo.
const BATCH_MAX = 3;   // one 31b pass grounds ~3 independent one-fact lookups before quality dilutes

function isBatchable(item) {
  if (!item) return false;
  if (item.kind === 'open-question') return true;
  if (item.kind === 'absence') return !_rosterShaped((item.detail || {}).predicate);
  return false;
}

function buildBatchPrompt(items) {
  const parts = items.map((item, i) => {
    const d = item.detail || {};
    const held = heldContext(item.subject, { limit: 2 });
    const what = item.kind === 'absence'
      ? `the ${d.predicate || 'missing fact'} of "${item.subject}" (${d.attempts || 1} prior attempt(s))`
      : `${item.kind}: ${item.subject}`;
    return `GAP ${i + 1} — ${what}${d.doc ? ` (a pending entry in the doc "${d.doc}")` : ''}${held}`;
  });
  return `VERIFICATION PASS — ${items.length} small known gaps batched into one run. Verify each INDEPENDENTLY; never let one gap's finding bleed into another's verdict.\n\n${parts.join('\n')}\n${LOCAL_FIRST}\nFor EACH gap, end your answer with EXACTLY ONE line: "GAP <n> RESOLVED: <the fact + its source inline>" or "GAP <n> STILL-UNKNOWN: <what you checked>". A claim without a source is not RESOLVED. A gap you did not get to gets NO line (it will be retried).`;
}

/** parseBatchVerdicts(ans, count) → per-index {verdict, line}; a missing GAP line stays
 * inconclusive, which the consumer routes to defer-with-backoff — an honest retry, never a guess. */
function parseBatchVerdicts(ans, count) {
  const out = Array.from({ length: Math.max(0, count) }, () => ({ verdict: 'inconclusive', line: '' }));
  for (const line of str(ans).split('\n')) {
    const m = line.match(/^\s*GAP\s*(\d+)\s*[—:–-]*\s*(RESOLVED|STILL-UNKNOWN)\s*:\s*(.*)$/i);
    if (!m) continue;
    const i = Number(m[1]) - 1;
    if (i >= 0 && i < out.length) out[i] = { verdict: m[2].toUpperCase() === 'RESOLVED' ? 'resolved' : 'unknown', line: m[3].slice(0, 400) };
  }
  return out;
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
      // A roster-shaped resolve lands STRUCTURED — the store grows, the next doc fill sees it.
      if (_rosterShaped((item.detail || {}).predicate)) {
        try {
          const members = parseRoster(ans);
          if (members.length) {
            const civ = require('./civic_store');
            civ.upsertBody({ title: item.subject, level: 'other' });   // memberships require the body row
            const r = civ.recordRoster({ bodyTitle: item.subject, members, sourceKind: 'operator' });
            if (r.ok) v.line = `${v.line} [${r.stored + r.unchanged} member(s) recorded to the civic store]`;
          }
        } catch { /* structured capture is best-effort; the resolve itself stands */ }
      }
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

module.exports = { enqueue, due, openByKind, complete, defer, stats, sweepAbsences, buildPrompt, parseVerdict, parseRoster, applyOutcome, backoffMs, isBatchable, buildBatchPrompt, parseBatchVerdicts, BATCH_MAX };
