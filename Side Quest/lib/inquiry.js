/**
 * lib/inquiry.js — LINES OF INQUIRY (catalog O0, slice 4, 2026-07-23).
 *
 * Boot40, measured: the one model-driven lane made ZERO decisions all day while ~800 code-picked
 * moves ran — and even when the driver fires, one decision became one bounded run and a one-line
 * history entry; the next tick re-decided from counts. Continuity was against the rules (the
 * variety instruction), so her background read as a scan schedule. Lucas: "the background research
 * is still non logical, the models aren't driving the lanes."
 *
 * The unit of autonomous work stops being a TICK and becomes a QUESTION — an object that persists,
 * accretes cited evidence, and carries a model-written next_step, so the next touch starts where
 * this one stopped. This is the persistence his ASSIGNMENTS always had (a directed focus accretes,
 * parks, resumes — #3542 proved it across a reboot), extended to her own chosen work. The variety
 * rule survives ACROSS inquiries and dies WITHIN one.
 *
 * Disciplines carried in (the catalog's own laws):
 *  - Evidence APPENDS; the gist is REWRITTEN only from the model's own write-back at touch end —
 *    never a rolling rewrite of the record (the meeting-notes lesson).
 *  - The write-back ENVELOPE is defined at dispatch and validated in code (§6 L2): a touch that
 *    returns nothing structured still advances honestly ("no write-back — trail carries the miss").
 *  - Bounded: ≤MAX_ACTIVE live inquiries; opening past the cap PARKS the stalest, never refuses
 *    silently. Closing honestly (answered OR dead-end) is first-class, like `nothing`.
 *  - A closed-answered inquiry lands its answer as a doc_store artifact (source 'inquiry') — the
 *    same long-term arc every document rides.
 *
 * Pure logic + deps-injected db → offline-smokeable. Fail-soft everywhere.
 */
'use strict';

const str = (v) => (v == null ? '' : String(v));
const MAX_ACTIVE = 4;
const EVIDENCE_MAX = 30;
const jarr = (s) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

function _db(deps) { return (deps && deps.db) || require('./db'); }

function get(id, { deps = {} } = {}) {
  try { return _db(deps).getDb().prepare('SELECT * FROM inquiries WHERE id = ?').get(Number(id) || 0) || null; } catch { return null; }
}
function listActive({ deps = {} } = {}) {
  try { return _db(deps).getDb().prepare("SELECT * FROM inquiries WHERE status = 'active' ORDER BY last_touched_ts DESC").all(); } catch { return []; }
}

// Question similarity for the open-dedup guard (2026-07-23, boot73 measured: the decider opened
// #6 as a near-verbatim copy of #1 — four inquiries became ONE Louisiana-parish-officials question
// because a 25-touch line that never closed LOOKED stuck, so the model spawned fresh copies). Keys
// on DISTINCTIVE content words (drop the interrogative + generic-inquiry vocabulary that every
// question shares), then overlap over the smaller set — the same recipe as the domain leash + the
// capability-need dedup, one family of matcher across the codebase.
const _Q_STOP = new Set([
  'what', 'which', 'who', 'whose', 'when', 'where', 'how', 'many', 'the', 'and', 'for', 'are', 'that',
  'this', 'with', 'current', 'currently', 'list', 'lists', 'provides', 'provide', 'source', 'sources',
  'official', 'officials', 'authoritative', 'obtain', 'each', 'other', 'key', 'their', 'from', 'into',
  'get', 'find', 'compile', 'up', 'date', 'up-to-date', 'database', 'website', 'pdf', 'them', 'these',
]);
function _qTokens(q) {
  return new Set((str(q).toLowerCase().match(/[a-z]{3,}/g) || []).filter((w) => !_Q_STOP.has(w)));
}
function questionOverlap(a, b) {
  const ta = _qTokens(a), tb = _qTokens(b);
  if (!ta.size || !tb.size) return 0;
  let hit = 0; for (const w of ta) if (tb.has(w)) hit++;
  return hit / Math.min(ta.size, tb.size);
}
const DUP_THRESHOLD = 0.6;

// Open a line of inquiry. Over the cap, the stalest ACTIVE inquiry PARKS (resumable, never lost).
function open({ question, bornFrom = null, deps = {}, nowMs = Date.now() } = {}) {
  const q = str(question).replace(/\s+/g, ' ').trim();
  if (q.length < 15) return { id: null, reason: 'a real question is at least a sentence' };
  try {
    const d = _db(deps).getDb();
    // DEDUP GUARD: never open a near-duplicate of an inquiry that already exists. An ACTIVE twin →
    // advance IT (continuity is the default anyway); an already-ANSWERED twin → the question is
    // solved, opening it again would re-spend the whole line. Recently-parked twins count too.
    let existing = [];
    try { existing = d.prepare("SELECT id, question, status FROM inquiries WHERE status IN ('active','parked','closed_answered') ORDER BY last_touched_ts DESC").all(); } catch {}
    for (const e of existing) {
      if (questionOverlap(q, e.question) >= DUP_THRESHOLD) {
        return { id: e.status === 'closed_answered' ? null : e.id, duplicate: true, existing: e.status, existingId: e.id, reason: `near-duplicate of inquiry #${e.id} (${e.status})` };
      }
    }
    const active = listActive({ deps });
    if (active.length >= MAX_ACTIVE) {
      const stalest = active[active.length - 1];
      d.prepare("UPDATE inquiries SET status = 'parked' WHERE id = ?").run(stalest.id);
    }
    const info = d.prepare(`INSERT INTO inquiries (question, born_from, status, evidence, open_leads, expect_trail, created_ts, last_touched_ts)
      VALUES (?, ?, 'active', '[]', '[]', '[]', ?, ?)`).run(q, str(bornFrom).slice(0, 160) || null, nowMs, nowMs);
    return { id: info.lastInsertRowid };
  } catch (e) { console.error('[inquiry] open failed:', e.message); return { id: null, reason: e.message }; }
}

// The operator brief for one touch — question + where it stands + what to do next. The run starts
// where the last one stopped; that is the whole organ.
function touchBrief(row) {
  if (!row) return '';
  const ev = jarr(row.evidence).slice(-4);
  const leads = jarr(row.open_leads).slice(0, 5);
  const trail = jarr(row.expect_trail).slice(-3);
  const parts = [`LINE OF INQUIRY #${row.id} (touch ${(row.touches || 0) + 1}) — the QUESTION you are answering across sessions:\n"${row.question}"`];
  if (row.gist) parts.push(`WHERE IT STANDS (your own summary from last touch): ${str(row.gist).slice(0, 700)}`);
  if (ev.length) parts.push('EVIDENCE SO FAR (cited; the full trail persists):\n' + ev.map((e) => `- ${str(e.gist).slice(0, 160)}${e.cite ? ` [${str(e.cite).slice(0, 80)}]` : ''}`).join('\n'));
  // 200, not 120: a lead carrying a direct URL is useless truncated — the address is the lead
  // (live 2026-07-23: a verified file URL sat at char ~150 and the model kept guessing paths).
  if (leads.length) parts.push('OPEN LEADS you named:\n' + leads.map((l) => `- ${str(l).slice(0, 200)}`).join('\n'));
  if (row.next_step) parts.push(`YOUR OWN NEXT STEP from last touch — start here unless the evidence says otherwise: ${str(row.next_step).slice(0, 240)}`);
  if (trail.length) parts.push('EXPECT TRAIL: ' + trail.map((t) => (t.met ? 'met' : `NOT met (${str(t.why).slice(0, 60)})`)).join(' · '));
  parts.push('Advance the question THIS touch — new evidence with sources, a lead run down, or a dead end named honestly. A touch is ONE bounded run: take the next concrete bite and COMPLETE it (open the source, record what it shows, cite it) rather than attempting the whole remainder. Do not restate what the evidence already holds. Work TOP-DOWN: establish the containing structure\'s FORM first — what body governs/houses this level and what shape it takes — THEN enumerate downward into its members (a country houses states, a state houses counties/parishes, those house municipalities, those house people and organizations). Never collect members of a container whose form you have not established.');
  return parts.join('\n\n');
}

// §6 L2 — the envelope is defined at dispatch, validated at the drain.
const WRITEBACK_WANT = `The touch is over. Write back what the NEXT touch needs to start where you stopped. Reply ONLY strict JSON:
{"learned":"<1-3 sentences — where the question now stands. This REPLACES your standing summary, so it must CARRY FORWARD every coverage claim the old summary already held (a sub-list once completed stays completed — merge this touch's gains INTO the old standing, never restate only what THIS touch did)>",
 "new_evidence":[{"gist":"<one finding>","cite":"<source: url / doc / tool that showed it>"}],
 "leads":["<open lead worth pursuing>", "..."],
 "next_step":"<ONE BOUNDED bite the next touch can COMPLETE in a single short run — a specific source to open, a named subset to fill (e.g. 'the 13 missing clerks'), one claim to verify. NEVER the whole remaining work>",
 "status":"continue|answered|dead_end"}
Ground everything in what the run actually returned — an empty new_evidence with an honest learned beats invented findings. If the step this touch ran failed the SAME way the EXPECT TRAIL already shows, next_step MUST switch to a DIFFERENT open lead — never re-pin a step that has now failed twice (a source your tools cannot consume stays unconsumable). "answered"/"dead_end" only when the QUESTION itself is resolved or provably unanswerable.`;

function validateWriteback(raw) {
  try {
    const m = str(raw).match(/\{[\s\S]*\}/);
    if (!m) return { valid: false, error: 'no JSON object' };
    const o = JSON.parse(m[0]);
    const out = {
      learned: str(o.learned).replace(/\s+/g, ' ').trim().slice(0, 700),
      new_evidence: (Array.isArray(o.new_evidence) ? o.new_evidence : []).slice(0, 8)
        .map((e) => ({ gist: str(e && e.gist).replace(/\s+/g, ' ').trim().slice(0, 240), cite: str(e && e.cite).trim().slice(0, 160) }))
        .filter((e) => e.gist),
      leads: (Array.isArray(o.leads) ? o.leads : []).slice(0, 6).map((l) => str(l).replace(/\s+/g, ' ').trim().slice(0, 160)).filter(Boolean),
      next_step: str(o.next_step).replace(/\s+/g, ' ').trim().slice(0, 300),
      status: ['continue', 'answered', 'dead_end'].includes(o.status) ? o.status : 'continue',
    };
    if (!out.learned) return { valid: false, error: 'learned is required' };
    return { valid: true, value: out };
  } catch (e) { return { valid: false, error: e.message }; }
}

// Apply a validated write-back: evidence APPENDS (capped with an honest trim), gist/leads/next_step
// replace (they are the model's own summary of its own state), touches++.
function writeBack(id, env, { deps = {}, nowMs = Date.now() } = {}) {
  const row = get(id, { deps });
  if (!row || !env) return false;
  try {
    let ev = jarr(row.evidence).concat((env.new_evidence || []).map((e) => ({ ts: nowMs, gist: e.gist, cite: e.cite || null })));
    if (ev.length > EVIDENCE_MAX) ev = [{ ts: ev[0].ts, gist: `(older evidence trimmed — ${ev.length - EVIDENCE_MAX + 1} entries live on in the closed artifact/doc trail)`, cite: null }].concat(ev.slice(-(EVIDENCE_MAX - 1)));
    _db(deps).getDb().prepare(`UPDATE inquiries SET evidence = ?, gist = ?, open_leads = ?, next_step = ?, touches = touches + 1, last_touched_ts = ? WHERE id = ?`)
      .run(JSON.stringify(ev), env.learned || row.gist, JSON.stringify(env.leads || []), env.next_step || null, nowMs, id);
    return true;
  } catch (e) { console.error('[inquiry] writeBack failed:', e.message); return false; }
}

function expectTrailPush(id, verdict, { deps = {} } = {}) {
  const row = get(id, { deps });
  if (!row || !verdict || typeof verdict.met !== 'boolean') return;
  try {
    const t = jarr(row.expect_trail).concat([{ met: verdict.met, why: str(verdict.why).slice(0, 120) }]).slice(-8);
    _db(deps).getDb().prepare('UPDATE inquiries SET expect_trail = ? WHERE id = ?').run(JSON.stringify(t), id);
  } catch (e) { console.error('[inquiry] trail push failed:', e.message); }
}

// Honest closure — answered lands the answer as a durable document (the same arc everything rides).
function close(id, { kind = 'answered', answer = '', deps = {}, nowMs = Date.now() } = {}) {
  const row = get(id, { deps });
  if (!row) return { closed: false, reason: 'no such inquiry' };
  const status = kind === 'dead_end' ? 'closed_dead_end' : 'closed_answered';
  try {
    _db(deps).getDb().prepare('UPDATE inquiries SET status = ?, answer = ?, closed_ts = ? WHERE id = ?').run(status, str(answer).slice(0, 2000) || null, nowMs, id);
    let docId = null;
    if (status === 'closed_answered') {
      const ev = jarr(row.evidence);
      const body = [`_Line of inquiry #${row.id} · ${row.touches} touch(es) · born from: ${row.born_from || 'her own state'}_`, '',
        `## Question\n${row.question}`, `## Answer\n${str(answer) || str(row.gist)}`,
        ev.length ? `## Evidence trail\n${ev.map((e) => `- ${e.gist}${e.cite ? ` [${e.cite}]` : ''}`).join('\n')}` : ''].filter(Boolean).join('\n');
      const land = (deps.land || require('./doc_store').land);
      const r = land({ title: `Inquiry — ${str(row.question).slice(0, 90)}`, body, source: 'inquiry', ref: `inquiry-${row.id}` });
      docId = r && r.id;
      require('./kg_activity').emit({ db: 'sidequest', kind: 'node.born', anchor: `Inquiry — ${str(row.question).slice(0, 60)}` });
    }
    return { closed: true, status, docId };
  } catch (e) { console.error('[inquiry] close failed:', e.message); return { closed: false, reason: e.message }; }
}

// Manifest lines — the decider's continuity surface: what is OPEN, where each stands, what's next.
function manifestLines({ deps = {}, nowMs = Date.now() } = {}) {
  const rows = listActive({ deps });
  const lines = rows.map((r) => {
    const trail = jarr(r.expect_trail).slice(-2).map((t) => (t.met ? 'met' : 'NOT met')).join('/');
    return `   - [inquiry #${r.id}] "${str(r.question).slice(0, 90)}" — ${r.touches} touch(es)${r.next_step ? `; next: ${str(r.next_step).slice(0, 90)}` : ''}${trail ? ` (${trail})` : ''}`;
  });
  try {
    const parked = _db(deps).getDb().prepare("SELECT COUNT(*) n FROM inquiries WHERE status = 'parked'").get().n;
    if (parked) lines.push(`   - (${parked} parked — reopenable)`);
  } catch {}
  return lines;
}

module.exports = {
  MAX_ACTIVE, EVIDENCE_MAX, WRITEBACK_WANT, DUP_THRESHOLD,
  open, get, listActive, touchBrief, validateWriteback, writeBack, expectTrailPush, close, manifestLines,
  questionOverlap,
};
