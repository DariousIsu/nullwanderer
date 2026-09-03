/*
 * lib/recheck_queue.js — THE METABOLISM's worklist. PURE decision logic + a fail-soft store edge.
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

// ── THE SUBJECT FLOOR (2026-08-21, the "nonsensical unprompt" catch) ────────────────────────────
// The conversation-warming producer was minting an absence row for practically every noun phrase
// a conversation carried — "that", "they", "a guy", "paper", "your body", a bare YouTube URL —
// each burning up to 5 metabolism passes before the gap plan then presented them to Lucas as
// research gaps needing "a whole-site crawl of the official source". A subject the metabolism can
// actually RESEARCH names something: it carries a proper-noun-ish token (or a real number, e.g. a
// bill), is not a pronoun/deictic/generic-noun fragment, and is not a URL or file path. Shared by
// the producer (never enqueue), sweepAbsences (junk absences never re-enter), and the gap plan
// (never presented). Parked rows are reversible; the net errs toward parking vagueness.
const _SUBJ_JUNK_RE = /^(?:that|this|it|they|them|those|these|he|she|him|her|we|you|i|me|us|a (?:guy|girl|man|woman|thing)|some(?:one|thing|body)|any(?:one|thing)|every(?:one|thing)[\s\S]*|stuff|things?|papers?|docs?|documents?|compan(?:y|ies)|politicians?|agents?|captains?|planes?|op-?eds?|firehouse|(?:your |my )?body|scratch doc|test pass)$/i;
// requireProper:false = the LAX floor for sources that LOWERCASE their subjects (the absence store
// does — "ward 3 alderman of testville") where the proper-noun test would starve every legitimate
// row. The lax floor still rejects junk words, URLs, file paths, and fragments under 5 chars.
function researchable(subject, { requireProper = true } = {}) {
  const s = String(subject || '').trim();
  if (s.length < 5) return false;
  if (/^https?:\/\//i.test(s)) return false;                       // a bare URL is a fetch, not a gap
  if (/^[\w./\\-]+\.(?:md|txt|csv|pdf|docx?)$/i.test(s)) return false;   // a held file path is not a research subject
  if (_SUBJ_JUNK_RE.test(s)) return false;
  if (requireProper && !/[A-Z]/.test(s) && !/\b\d{2,4}\b/.test(s)) return false;   // no proper noun and no number → a generic fragment
  return true;
}

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
  try {
    db().getDb().prepare(`UPDATE recheck_queue SET status = 'done', outcome = ?, last_attempt_ts = ?, attempts = attempts + 1 WHERE id = ?`).run(str(outcome).slice(0, 500), now, id);
    // A resolved pursuit is the program's one universal satisfaction signal (promise paid, absence
    // answered, verification landed) — the affect substrate's win channel (internal_state v3). The
    // failure paths (defer/backoff) never come here, so `done` is honestly a win.
    try { require('./obs_bus').emit({ lane: 'pursuit', kind: 'win', text: `resolved: ${str(outcome).slice(0, 120) || 'done'}`, ref: `rq:${id}` }); } catch {}
    return true;
  }
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

// THE QUOTA HOLD (continuity cure #2, 2026-09-02). A pass the operator SKIPPED because the research
// lane was closed is not an attempt — nothing was looked up, nothing failed. It used to route through
// defer(): attempts+1 and an exponential backoff, so a quota-closed hour pushed a gap out 6h, then
// 12h, … up to a WEEK per tick, and the open plate showed items at attempts 10–15 that had never
// been researched that many times. A hold re-arms the item a short way out and leaves the attempt
// count (and the backoff it drives) untouched — the gap comes back the moment the lane reopens.
const QUOTA_HOLD_MS = 20 * 60 * 1000;
function hold(id, { now = Date.now(), ms = QUOTA_HOLD_MS } = {}) {
  try {
    db().getDb().prepare(`UPDATE recheck_queue SET due_ts = ? WHERE id = ? AND status = 'open'`).run(now + Math.max(60 * 1000, ms | 0), id);
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
      if (!researchable(g.subject, { requireProper: false })) continue;   // junk absences never re-enter (LAX: the store lowercases)
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

/** parseLocalRoster(ans) — the richer local-government verdict: an optional "BODY: <name>" (the
 * research-CONFIRMED body name, which may correct the frame's hypothesis), a "PRESIDING: <name> | <title>"
 * line, and "ROSTER: <name> | <role> | <email> | <phone>" lines (email/phone tolerate "-"/blank). Pure.
 * → { body, members:[{personName, role, email, phone}] }. */
function parseLocalRoster(ans) {
  const text = str(ans);
  const clean = (s) => { const t = str(s).trim(); return (!t || t === '-' || /^(none|n\/a|unknown|tbd|not published|not listed)$/i.test(t)) ? null : t; };
  let body = null;
  const members = [];
  const byName = new Map();
  // add-or-MERGE: a person named on both a PRESIDING and a ROSTER line is ONE member — the richer line fills
  // the missing fields (so the presiding officer's contact, printed on the ROSTER line, is never lost).
  const add = (name, { role, email, phone } = {}) => {
    const n = str(name).replace(/\s+/g, ' ').trim();
    if (!n || /^(none|n\/a|unknown|vacant)$/i.test(n)) return;
    const k = n.toLowerCase();
    const ex = byName.get(k);
    if (!ex) { const m = { personName: n, role: role || 'Member', email: email || null, phone: phone || null }; byName.set(k, m); members.push(m); return; }
    if (email && !ex.email) ex.email = email;
    if (phone && !ex.phone) ex.phone = phone;
    if (role && role !== 'Member' && (ex.role === 'Member' || !ex.role)) ex.role = role;   // a specific role beats the generic
  };
  for (const line of text.split('\n')) {
    const b = line.match(/^\s*BODY:\s*(.{3,120})$/i);
    if (b) { body = b[1].trim(); continue; }
    const p = line.match(/^\s*PRESIDING:\s*([^|]{2,80}?)\s*(?:\|\s*(.{0,60}))?$/i);
    if (p) { add(p[1], { role: clean(p[2]) || 'Presiding Officer' }); continue; }
    const r = line.match(/^\s*ROSTER:\s*([^|]{2,80}?)\s*(?:\|\s*([^|]{0,60}))?\s*(?:\|\s*([^|]{0,80}))?\s*(?:\|\s*(.{0,40}))?$/i);
    if (r) add(r[1], { role: clean(r[2]) || 'Member', email: clean(r[3]), phone: clean(r[4]) });
  }
  return { body, members };
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
    let rows = null;
    // FAST PATH (2026-08-17): documents_fts MATCH is ~1ms vs the ~1.4s full-table LIKE this replaced — the
    // confirmed carrier of the metabolism main-thread stall (this scan ran 1–3× per metabolism prompt over
    // 17k docs / 1.29GB body). Each token → an fts5 PREFIX term (alnum-sanitized) AND-joined, so a row must
    // carry every token in title OR body — the same intent as the LIKE. The JOIN reads display columns from
    // documents (documents_fts is external-content, no stored copy).
    if (db().documentsFtsReady && db().documentsFtsReady()) {
      const terms = toks.map((t) => t.replace(/[^a-z0-9]/g, '')).filter(Boolean).map((t) => `${t}*`);
      if (terms.length) {
        try {
          // ORDER BY bm25 (RELEVANCE), not created_ts: a common token ("county") matches thousands of docs,
          // and ORDER BY d.created_ts DESC would force the JOIN to materialize + sort EVERY match before LIMIT
          // (live-measured 200–470ms). bm25 lets fts5 return the top-K internally → 2–14ms (live-measured),
          // and the most-relevant held doc is a better "check this first" hint than merely the newest.
          rows = db().getDb().prepare(
            `SELECT d.id, d.title, d.source, d.created_ts FROM documents_fts f JOIN documents d ON d.id = f.rowid WHERE documents_fts MATCH ? ORDER BY bm25(documents_fts) LIMIT ?`
          ).all(terms.join(' AND '), limit);
        } catch { rows = null; }   // malformed MATCH → fall through to the LIKE, never throw
      }
    }
    if (!rows) {   // FALLBACK — the original full-table LIKE (index not built yet, or MATCH errored). Never worse than before.
      const like = toks.map(() => `(title LIKE ? OR body LIKE ?)`).join(' AND ');
      const params = []; for (const w of toks) params.push(`%${w}%`, `%${w}%`);
      rows = db().getDb().prepare(
        `SELECT id, title, source, created_ts FROM documents WHERE ${like} ORDER BY created_ts DESC LIMIT ?`
      ).all(...params, limit);
    }
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
    case 'local-roster': {
      // Spine 3 leaf-fill: research ONE local governing body, TOP-DOWN from its official site, with the R3
      // scoping so the pass grabs the LEGISLATIVE body — never a row office (the census failure).
      const kinds = Array.isArray(d.bodyKinds) && d.bodyKinds.length ? d.bodyKinds.join(', ') : 'the county/parish governing council or commission';
      const excl = Array.isArray(d.exclude) && d.exclude.length ? d.exclude.join(', ') : 'sheriff, clerk, district attorney, assessor';
      const hyp = d.body ? ` Its form is PRESUMED "${d.body}" (${d.govSource || 'hypothesis'}) — confirm that, or correct it to the real body.` : '';
      const where = [d.place || item.subject, d.state].filter(Boolean).join(', ');
      return `LOCAL ROSTER — research the GOVERNING BODY of ${where}.${hyp} The governing body is the locality's LEGISLATIVE/deliberative authority — one of: ${kinds}. It is NOT an independently-elected row office (EXCLUDE: ${excl}). Work TOP-DOWN: start from the OFFICIAL ${d.place || 'parish/county'} government website.${held}${LOCAL_FIRST}
Output IN THIS ORDER, then STOP:
- the verdict line — "RESOLVED: <official source URL + one sentence>" or "STILL-UNKNOWN: <what you checked>";
- "BODY: <the official body name>";
- "PRESIDING: <full name> | <title>";
- one "ROSTER: <full name> | <role or Member> | <email or -> | <phone or ->" line per verified member.
Only what the source actually prints — invent NOTHING; put "-" for any contact not published. ${VERDICT_CONTRACT}`;
    }
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
    // Spine 3 leaf-fill: a resolved local-roster lands the body + its members STRUCTURED into the civic
    // store, under a LOCALITY-scoped title (the parish/county name is in the title → distinct body_key, no
    // cross-locality collapse). The research-confirmed BODY name (if any) overrides the frame hypothesis.
    if (item.kind === 'local-roster') {
      try {
        const parsed = parseLocalRoster(ans);
        const civ = require('./civic_store');
        const title = parsed.body || (item.detail || {}).body || item.subject;
        civ.upsertBody({ title, level: 'county', function: 'governing', state: (item.detail || {}).state || null, place: (item.detail || {}).place || null });
        if (parsed.members.length) {
          const r = civ.recordRoster({ bodyTitle: title, members: parsed.members, sourceKind: 'operator' });
          if (r && r.ok) v.line = `${v.line} [${r.stored + r.unchanged} member(s) → "${title}"]`;
        } else {
          v.line = `${v.line} [body "${title}" recorded; no members parsed]`;
        }
      } catch { /* structured capture is best-effort; the resolve line still stands */ }
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

module.exports = { enqueue, due, openByKind, complete, defer, hold, stats, sweepAbsences, buildPrompt, heldContext, parseVerdict, parseRoster, parseLocalRoster, applyOutcome, backoffMs, isBatchable, buildBatchPrompt, parseBatchVerdicts, BATCH_MAX, QUOTA_HOLD_MS, researchable };
