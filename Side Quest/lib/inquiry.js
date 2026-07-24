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
  // CLOSE NUDGE (2026-07-23, boot73: inquiry #1 ran 25 touches and never closed even after its
  // authoritative source landed in the graph). A "for each of the 64…" enumeration question never
  // FEELS finished to a cautious model, so status defaults to "continue" forever — the 0-for-N
  // disease in close form. Once a line has run several touches with real evidence, make CLOSING
  // first-class: answerable-from-what-you-hold beats a 12th "continue". Model still decides; a
  // specific named gap is always a legitimate "continue".
  if ((row.touches || 0) >= 4 && ev.length) {
    parts.push(`THIS LINE HAS RUN ${row.touches} TOUCHES. Closing is a FIRST-CLASS outcome, not a failure. If the question is answerable from what you already hold — especially any authoritative source named in your leads or next step — set status ANSWERED this touch and cite it; a comprehensive re-verification of every item is NOT required to close, and an honest "answered" beats another "continue". Only continue if a SPECIFIC, NAMED gap blocks the answer — and if so, name that gap as the next step.`);
  }
  parts.push('Advance the question THIS touch — new evidence with sources, a lead run down, or a dead end named honestly. A touch is ONE bounded run: take the next concrete bite and COMPLETE it (open the source, record what it shows, cite it) rather than attempting the whole remainder. Do not restate what the evidence already holds. Work TOP-DOWN: establish the containing structure\'s FORM first — what body governs/houses this level and what shape it takes — THEN enumerate downward into its members (a country houses states, a state houses counties/parishes, those house municipalities, those house people and organizations). Never collect members of a container whose form you have not established.');
  return parts.join('\n\n');
}

// ACCESS HINT (PLAN_MAP §5: "the map exists; the touch prompt doesn't see it") — an inquiry's
// next_step / leads / evidence often name specific sites (a .gov portal, a county page). The host's
// LEARNED access profile — which door worked, in what order, concessions noted — lives in the site
// ledger but never reached the touch, so each touch re-learned the doors from scratch. This scans the
// row's own text for URLs and surfaces accessLine() for the hosts it references, so the operator tries
// the doors in the order that WORKED last time. Kept OUT of the pure touchBrief (which stays hermetic,
// like heldSourceHint) and appended at the brief-assembly site. Fail-soft: '' when no host has a profile.
const _ACCESS_URL_RE = /https?:\/\/[^\s"'<>)\]]+/gi;
function accessHint(row, { deps = {} } = {}) {
  if (!row) return '';
  try {
    const sl = (deps && deps.siteLedger) || require('./site_ledger');
    const blob = [row.next_step, ...jarr(row.open_leads), ...jarr(row.evidence).map((e) => `${(e && e.gist) || ''} ${(e && e.cite) || ''}`)].map(str).join(' ');
    const hosts = [...new Set((blob.match(_ACCESS_URL_RE) || []).map((u) => { try { return sl.hostOf(u); } catch { return ''; } }).filter(Boolean))].slice(0, 4);
    const lines = hosts.map((h) => { try { return sl.accessLine(h); } catch { return null; } }).filter(Boolean);
    if (!lines.length) return '';
    return 'ACCESS NOTES — how these sites let you in last time (try the doors in this order; ✓ worked, ✗ did not):\n' + lines.join('\n');
  } catch { return ''; }
}

// HELD-SOURCE HINT (2026-07-23, boot73: inquiry #1 ran 26 touches planning to "retrieve the
// LA-parish-officials-2026.xls file via its direct download URL" — a file it ALREADY HELD as a
// landed, decomposed doc). She has no reflex to check her own stores before re-fetching. This scans
// the inquiry's own text (next_step/gist/recent evidence) for a filename it names, and if that file
// is already a landed document, tells the touch to READ its own copy instead of re-downloading. The
// general lesson (check what you hold first) outlives this one inquiry. deps.db required; fail-soft.
const _FILE_RE = /[\w()][\w()\-. ]{2,80}\.(?:xlsx?|csv|pdf|docx?|tsv|json)/gi;
// STRUCTURE, not a raw excerpt (boot76: the roster's first 2000 chars are party-committee rows —
// DSCC/RPEC noise — NOT the parish sheriffs/clerks, so the injected head actively confused the
// operator about what office titles exist). For a table doc, surface the HEADER + the distinct
// values of the first column with counts: "Sheriff ×64, Clerk of Court ×64, President ×24…" tells
// the operator exactly what to filter for. Pure; returns null for a non-table body.
function _summarizeTable(body) {
  try {
    const rows = str(body).split(/\r?\n/).filter((l) => l.trim().startsWith('|'));
    if (rows.length < 3) return null;
    const cells = (l) => l.split('|').map((s) => s.trim());
    const header = cells(rows[0]).filter(Boolean);
    if (header.length < 2) return null;
    const counts = new Map();
    let data = 0;
    for (const l of rows) {
      if (/^\|\s*-{2,}/.test(l)) continue;            // separator row
      const c = cells(l);
      const v = c[1];                                  // first content column
      if (!v || v === header[0]) continue;
      counts.set(v, (counts.get(v) || 0) + 1);
      data++;
    }
    if (!counts.size) return null;
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
    return { header: header.join(' | '), col0: header[0], nRows: data, nDistinct: counts.size, top };
  } catch { return null; }
}
function _renderHeldHint(doc, deps, summary) {
  let decomposed = false;
  try { decomposed = (deps.db || require('./db')).getDb().prepare('SELECT 1 FROM encounters WHERE source_ref = ? LIMIT 1').get(`doc:${doc.id}`) != null; } catch {}
  let sum = summary;
  if (sum === undefined) sum = _summarizeTable(doc.head);
  let inner;
  if (sum) {
    // Show the schema + what the key column actually CONTAINS, so the operator knows the whole
    // shape (and isn't drowned by the party-committee rows that lead the file). Lucas: BREAK DOWN
    // THE ENTIRE DOCUMENT — every row is a real elected official for the database; do NOT discard
    // the rows this one inquiry doesn't need. The inquiry's ANSWER is a view over the full ingest.
    inner = `It is a TABLE: ${sum.nRows} rows, columns [ ${sum.header} ]. EVERY row is a real elected official — the WHOLE document belongs in your database; break it ALL down, do not cherry-pick or discard the office types this question doesn't ask about. The "${sum.col0}" column holds these distinct values (value ×count):\n${sum.top.map(([v, n]) => `  ${v} ×${n}`).join('\n')}\nQuery your own copy: localdb SELECT body FROM documents WHERE id=${doc.id} (paged), grouping by the Parish column. To ANSWER THIS inquiry, read off the parish-government offices per parish (Sheriff, Clerk of Court, Assessor, and the governing body — President where the parish is home-rule, else Police Juror / Council) — while still ingesting the rest.`;
  } else {
    const excerpt = str(doc.head).replace(/\s+\n/g, '\n').slice(0, 1600);
    inner = `Here is the start; page the rest with localdb (SELECT substr(body, N, 3000) FROM documents WHERE id=${doc.id}):\n--- first ${excerpt.length} chars ---\n${excerpt}\n--- end ---`;
  }
  return `⚠️ YOU ALREADY HOLD THE ANSWER SOURCE. "${doc.title}" is doc #${doc.id} in your OWN store (${Math.round((doc.len || 0) / 1000)}k chars${decomposed ? ', decomposed into your entity graph' : ''}) — do NOT re-download or re-scrape it.\n${inner}\nUse THIS to answer. If it covers the question, CLOSE ANSWERED citing doc #${doc.id}. Re-fetching what you already hold is wasted work.`;
}
// A wider sample than the 2400-char head — a table's meaningful variety often starts past the first
// rows (the roster leads with 2,000+ party-committee rows before the parish offices). 40k chars is
// enough to see every distinct office title while staying cheap.
function _loadHeldDoc(d, id) {
  try { return d.prepare('SELECT id, title, LENGTH(body) AS len, substr(body,1,40000) AS head FROM documents WHERE id = ?').get(Number(id) || 0) || null; } catch { return null; }
}

// ── EXTRACT-AND-INJECT (boot80 fix): a plan is NOT the deliverable ────────────────────────────────
// #1 stalled at touch 30 because the hint told the operator to "query your own copy … grouping by
// Parish", so the operator kept emitting a SQL QUERY as its answer — which expect correctly rejects
// ("the actual output is a SQL query, not a markdown table"). The fix: when the held doc IS a
// structured table that answers the question, EXTRACT the grouped answer here and inject THAT, so the
// operator presents+cites+closes instead of writing a query it never runs. Party committees (not
// government) drop; the governing body leads (home-rule President+Council, else the Police Jury), then
// the constitutional officers — the parish-leadership VIEW over the full ingest. Config, not a channel:
// a generic table digest (lib/table_extract) ordered by what governs the container (top-down).
// Delegate to the shared roster extractor (lib/table_extract) — one implementation for the inquiry
// homecoming and the chat-path homecoming both.
function _extractHeldAnswer(body, { cite } = {}) {
  try { return require('./table_extract').officialsAnswer(body, { cite }); } catch { return null; }
}
function _renderExtractedHint(doc, deps, digest) {
  let decomposed = false;
  try { decomposed = (deps.db || require('./db')).getDb().prepare('SELECT 1 FROM encounters WHERE source_ref = ? LIMIT 1').get(`doc:${doc.id}`) != null; } catch {}
  return [
    `⚠️ YOU ALREADY HOLD THE ANSWER — and it is EXTRACTED below. "${doc.title}" is doc #${doc.id} in your own store${decomposed ? ' (decomposed into your entity graph)' : ''}. Do NOT re-download, re-scrape, or write a query — the rows are already pulled from your own copy.`,
    `THE ANSWER — ${digest.groups} groups (by ${digest.groupCol}), extracted from the roster and cited to doc #${doc.id}:`,
    digest.text,
    `PRESENT this as your answer table (it already cites doc #${doc.id}) and CLOSE ANSWERED. A SQL query or a "plan to parse" is NOT the deliverable — this table IS. The whole document stays ingested; this is the leadership VIEW over it.`,
  ].join('\n');
}
// Prefer the EXTRACTED answer; compute once from the FULL body and pin it (re-parsing 1.5MB every
// touch is waste), fall back to the structure-summary hint for a non-table held doc.
function _hintFor(doc, deps, dbm, row) {
  const answerKey = row && row.id != null ? `inquiry.${row.id}.held_answer` : null;
  let digest = null;
  if (answerKey) { try { const p = dbm.getMeta(answerKey); if (p) digest = JSON.parse(p); } catch {} }
  if (!digest) {
    let full = null;
    try { full = dbm.getDb().prepare('SELECT body FROM documents WHERE id = ?').get(doc.id); } catch {}
    if (full && full.body) {
      const ex = _extractHeldAnswer(full.body, { cite: `doc #${doc.id}` });
      if (ex) { digest = ex; if (answerKey) { try { dbm.setMeta(answerKey, JSON.stringify(ex)); } catch {} } }
    }
  }
  if (digest && digest.text) return _renderExtractedHint(doc, deps, digest);
  return _renderHeldHint(doc, deps);
}
function heldSourceHint(row, { deps = {} } = {}) {
  try {
    const dbm = deps.db || require('./db');
    const d = dbm.getDb();
    // PIN FIRST (boot74): the operator's write-back scrubs the roster filename out of next_step/gist/
    // leads, so a text-scan trigger stops firing after one touch and the inquiry "forgets" it holds
    // the answer. Once discovered, the held source is PINNED to the inquiry (meta) and re-emitted
    // every touch thereafter — surviving every write-back rewrite.
    const pinKey = row && row.id != null ? `inquiry.${row.id}.held_source_doc` : null;
    if (pinKey) {
      let pinned = null; try { pinned = dbm.getMeta(pinKey); } catch {}
      if (pinned) { const doc = _loadHeldDoc(d, pinned); if (doc && doc.id) return _hintFor(doc, deps, dbm, row); }
    }
    const hay = `${str(row && row.next_step)} ${str(row && row.gist)} ${jarr(row && row.open_leads).slice(0, 6).join(' ')} ${jarr(row && row.evidence).slice(-3).map((e) => str(e.gist) + ' ' + str(e.cite)).join(' ')}`;
    const seen = new Set();
    const names = (hay.match(_FILE_RE) || []).map((s) => s.trim()).filter((s) => { const k = s.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    for (const name of names.slice(0, 4)) {
      let doc = null;
      // Match either direction: the candidate IS a title, or a (>=8-char) title is CONTAINED in the
      // candidate (the space-greedy match pulls leading words — "Retrieve the <file>.xls" — so the
      // real title sits inside it). Prefer the most specific (longest) title.
      try { doc = d.prepare('SELECT id, title, LENGTH(body) AS len, substr(body,1,2400) AS head FROM documents WHERE title = ? OR (LENGTH(title) >= 8 AND ? LIKE \'%\' || title || \'%\') ORDER BY LENGTH(title) DESC LIMIT 1').get(name, name); } catch {}
      if (!doc || !doc.id) continue;
      if (pinKey) { try { dbm.setMeta(pinKey, String(doc.id)); } catch {} }   // PIN on discovery — survives the next write-back
      return _hintFor(doc, deps, dbm, row);
    }
    return null;
  } catch { return null; }
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

// HELD-SOURCE EXHAUSTED → CLOSE (boot80). When a COMPLETE answer has been extracted from the held
// authoritative source (heldSourceHint pinned `held_answer`) and the line has re-derived it across
// several touches without the write-back conceding "answered", the source is exhausted — close it.
// Root it fixes: expect-bar DRIFT. #1 held the full 64-parish roster and produced it every touch, but
// the expect bar ratcheted to demand per-official website URLs the roster never carried, so the touch
// kept framing a complete answer as "remaining to fill" and never set status=answered. The pinned
// digest IS the deliverable; an unmeetable bar must not keep a line grinding forever. Pure read.
const FORCE_CLOSE_TOUCHES = 4;
function heldAnswerExhausted(row, { deps = {} } = {}) {
  if (!row || row.id == null || row.status !== 'active') return false;
  if ((row.touches || 0) < FORCE_CLOSE_TOUCHES) return false;
  try { const v = (deps.db || require('./db')).getMeta(`inquiry.${row.id}.held_answer`); return !!(v && String(v).length > 40); } catch { return false; }
}
// The extracted digest text (the actual answer table) to store on the forced close, else null.
function heldAnswerText(id, { deps = {} } = {}) {
  try { const j = (deps.db || require('./db')).getMeta(`inquiry.${id}.held_answer`); const o = JSON.parse(j || 'null'); return o && o.text ? String(o.text) : null; } catch { return null; }
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
  open, get, listActive, touchBrief, accessHint, validateWriteback, writeBack, expectTrailPush, close, manifestLines,
  questionOverlap, heldSourceHint, heldAnswerExhausted, heldAnswerText, FORCE_CLOSE_TOUCHES,
};
