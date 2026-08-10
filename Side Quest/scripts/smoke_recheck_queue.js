'use strict';
/* smoke_recheck_queue.js — the metabolism's worklist (lib/recheck_queue.js). Hermetic temp sq.db.
 * Run: node scripts/smoke_recheck_queue.js */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recheck-smoke-'));
process.env.SQ_DB_PATH = path.join(tmp, 'sq.db');
const db = require(path.join(__dirname, '..', 'lib', 'db'));
db.init();
const rq = require(path.join(__dirname, '..', 'lib', 'recheck_queue'));
const absence = require(path.join(__dirname, '..', 'lib', 'absence'));

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', n); } };
const NOW = Date.now();

// ── enqueue: dedupe on open (kind,subject); re-enqueue raises priority, keeps earlier due ───────
const e1 = rq.enqueue({ kind: 'vacancy', subject: 'CA-14', priority: 6, now: NOW });
const e2 = rq.enqueue({ kind: 'vacancy', subject: 'CA-14', priority: 3, dueTs: NOW + 99999, now: NOW });
ok('first enqueue inserts', e1.ok && !e1.existing);
ok('duplicate open item merges, never duplicates', e2.ok && e2.existing && e2.id === e1.id);
const row1 = rq.due({ limit: 5, now: NOW }).find((r) => r.subject === 'CA-14');
ok('merge kept the higher priority + earlier due', row1 && row1.priority === 6 && row1.due_ts === NOW);

// ── due ordering: priority desc, then oldest due ────────────────────────────────────────────────
rq.enqueue({ kind: 'discrepancy', subject: 'low-pri', priority: 2, dueTs: NOW - 1000, now: NOW });
rq.enqueue({ kind: 'cardinality-conflict', subject: 'hi-pri', priority: 9, dueTs: NOW - 500, now: NOW });
rq.enqueue({ kind: 'discrepancy', subject: 'not-due-yet', priority: 9, dueTs: NOW + 3600000, now: NOW });
const plate = rq.due({ limit: 10, now: NOW });
ok('highest priority first', plate[0].subject === 'hi-pri');
ok('future items stay off the plate', !plate.some((r) => r.subject === 'not-due-yet'));

// ── complete / defer with backoff ───────────────────────────────────────────────────────────────
rq.complete(plate[0].id, { outcome: 'RESOLVED: test', now: NOW });
ok('completed leaves the queue', !rq.due({ limit: 10, now: NOW }).some((r) => r.subject === 'hi-pri'));
const dId = plate.find((r) => r.subject === 'low-pri').id;
rq.defer(dId, { now: NOW });
ok('deferred backs off (not due now)', !rq.due({ limit: 10, now: NOW }).some((r) => r.subject === 'low-pri'));
ok('deferred returns after the backoff', rq.due({ limit: 10, now: NOW + rq.backoffMs(1) + 1000 }).some((r) => r.subject === 'low-pri'));

// ── absence sweep: expired TTL → queued; fresh → left alone ─────────────────────────────────────
absence.recordMiss('Ward 3 Alderman of Testville', 'email', { now: NOW - 10 * 24 * 3600 * 1000 });   // long-expired
absence.recordMiss('Mayor of Freshtown', 'phone', { now: NOW });                                       // fresh
const sw = rq.sweepAbsences({ now: NOW });
ok('expired absence queued', sw.queued >= 1 && rq.due({ limit: 20, now: NOW }).some((r) => r.kind === 'absence' && /testville/i.test(r.subject)));
ok('fresh absence not queued', !rq.due({ limit: 20, now: NOW }).some((r) => /freshtown/i.test(r.subject)));
const sw2 = rq.sweepAbsences({ now: NOW });
ok('re-sweep dedupes', sw2.queued === 0);

// ── prompts carry the verdict contract; verdicts parse ──────────────────────────────────────────
const absItem = rq.due({ limit: 20, now: NOW }).find((r) => r.kind === 'absence');
ok('absence prompt names subject + contract', /testville/i.test(rq.buildPrompt(absItem)) && /RESOLVED:/.test(rq.buildPrompt(absItem)));
// ── DATABASE-FIRST (08-08: "all of this should already be in her database somewhere") ───────────
ok('absence prompt orders database-first', /DATABASE-FIRST/.test(rq.buildPrompt(absItem)));
db.insertDocument({ title: 'Ward 3 Alderman of Testville — contact sheet', body: 'Ward 3 Alderman of Testville: email alder@testville.gov', source: 'research' });
const heldPrompt = rq.buildPrompt(absItem);
ok('held docs on the subject are injected + named', /ALREADY HELD/.test(heldPrompt) && /doc#\d+/.test(heldPrompt) && /contact sheet/i.test(heldPrompt));
ok('no held docs → no held section, prompt still whole', !/ALREADY HELD/.test(rq.buildPrompt({ kind: 'absence', subject: 'zq unheard-of subject xv', detail: {} })) && /RESOLVED:/.test(rq.buildPrompt({ kind: 'absence', subject: 'zq unheard-of subject xv', detail: {} })));
ok('verdict: resolved parses', rq.parseVerdict('I checked.\nRESOLVED: email is x@y.gov (source: official site)').verdict === 'resolved');
ok('verdict: still-unknown parses', rq.parseVerdict('Looked everywhere.\nSTILL-UNKNOWN: checked official + news').verdict === 'unknown');
ok('verdict: rambling is inconclusive', rq.parseVerdict('I think it might be...').verdict === 'inconclusive');

// ── applyOutcome routes: resolved closes the gap; unknown re-arms the cycle; mute defers ────────
const out1 = rq.applyOutcome(absItem, 'RESOLVED: found it (source: x)', { now: NOW });
ok('resolved closes queue row + absence gap', out1.action === 'resolved' && !absence.get('Ward 3 Alderman of Testville', 'email'));
absence.recordMiss('Clerk of Missing County', 'email', { now: NOW - 10 * 24 * 3600 * 1000 });
rq.sweepAbsences({ now: NOW });
const absItem2 = rq.due({ limit: 20, now: NOW }).find((r) => /missing county/i.test(r.subject));
const before = absence.get('Clerk of Missing County', 'email');
const out2 = rq.applyOutcome(absItem2, 'STILL-UNKNOWN: checked county site', { now: NOW });
const after = absence.get('Clerk of Missing County', 'email');
ok('still-unknown completes the row + re-records the miss (attempts grow)', out2.action === 'still-unknown' && after && after.attempts > before.attempts);
rq.enqueue({ kind: 'discrepancy', subject: 'mute-case', priority: 5, dueTs: NOW - 1, now: NOW });
const muteItem = rq.due({ limit: 20, now: NOW }).find((r) => r.subject === 'mute-case');
ok('no verdict → deferred with backoff', rq.applyOutcome(muteItem, '', { now: NOW }).action === 'deferred' && !rq.due({ limit: 20, now: NOW }).some((r) => r.subject === 'mute-case'));

// ── structured roster capture: a resolve GROWS the civic store (08-08, the plan for the blanks) ─
const rosterItem = (() => {
  rq.enqueue({ kind: 'absence', subject: 'Testville Parish', detail: { predicate: 'Current officeholders', doc: 'Test doc' }, priority: 5, dueTs: NOW - 1, now: NOW });
  return rq.due({ limit: 30, now: NOW }).find((r) => r.subject === 'Testville Parish');
})();
ok('roster-shaped prompt carries the ROSTER contract + doc context', /ROSTER:/.test(rq.buildPrompt(rosterItem)) && /Test doc/.test(rq.buildPrompt(rosterItem)));
ok('parseRoster reads member lines', JSON.stringify(rq.parseRoster('found it\nRESOLVED: via site\nROSTER: Ann Green | President\nROSTER: Bo Blue')) === JSON.stringify([{ personName: 'Ann Green', role: 'President' }, { personName: 'Bo Blue', role: 'Member' }]));
ok('parseRoster ignores junk', rq.parseRoster('RESOLVED: prose only').length === 0);
rq.applyOutcome(rosterItem, 'checked the site.\nRESOLVED: roster found via testville.gov\nROSTER: Ann Green | President\nROSTER: Bo Blue | Member', { now: NOW });
const civ = require(path.join(__dirname, '..', 'lib', 'civic_store'));
const stored = civ.roster('Testville Parish');
ok('resolve recorded the roster structurally', stored.length === 2 && stored.some((r) => r.person_name === 'Ann Green' && r.role === 'President'));

// ── M9.3 batched small verifies: batchability, prompt, per-index verdicts ───────────────────────
ok('open-question is batchable', rq.isBatchable({ kind: 'open-question', subject: 'q', detail: {} }));
ok('non-roster absence is batchable', rq.isBatchable({ kind: 'absence', subject: 's', detail: { predicate: 'email' } }));
ok('roster absence is NOT batchable', !rq.isBatchable({ kind: 'absence', subject: 's', detail: { predicate: 'Current officeholders' } }));
ok('discrepancy/vacancy are NOT batchable', !rq.isBatchable({ kind: 'discrepancy', subject: 's' }) && !rq.isBatchable({ kind: 'vacancy', subject: 's' }));
const batchItems = [
  { kind: 'absence', subject: 'Clerk of Alpha County', detail: { predicate: 'email', attempts: 2 } },
  { kind: 'open-question', subject: 'Does Beta Parish levy a data center tax?', detail: {} },
];
const bp = rq.buildBatchPrompt(batchItems);
ok('batch prompt numbers each gap + carries both subjects', /GAP 1/.test(bp) && /GAP 2/.test(bp) && /Alpha County/.test(bp) && /Beta Parish/.test(bp));
ok('batch prompt demands per-gap verdict lines + database-first', /GAP <n> RESOLVED:/.test(bp) && /DATABASE-FIRST/.test(bp));
const bv = rq.parseBatchVerdicts('worked both.\nGAP 1 RESOLVED: clerk@alpha.gov (source: alpha.gov)\nGAP 2 STILL-UNKNOWN: checked assessor + news', 2);
ok('per-index verdicts parse', bv[0].verdict === 'resolved' && /alpha\.gov/.test(bv[0].line) && bv[1].verdict === 'unknown');
ok('a gap with no line stays inconclusive (→ defer path)', rq.parseBatchVerdicts('GAP 1 RESOLVED: x (source: y)', 3)[2].verdict === 'inconclusive');
ok('em-dash and case tolerated', rq.parseBatchVerdicts('gap 2 — resolved: fact (source: z)', 2)[1].verdict === 'resolved');
ok('out-of-range GAP index ignored', rq.parseBatchVerdicts('GAP 9 RESOLVED: x', 2).every((v) => v.verdict === 'inconclusive'));

// ── openByKind: the delivery path's getter for open promises (Spine 3) ──────────────────────────
rq.enqueue({ kind: 'promise', subject: 'roster#abc', detail: { deliverable: 'roster' }, dueTs: NOW - 1, now: NOW });
rq.enqueue({ kind: 'promise', subject: 'list#def', detail: { deliverable: 'list' }, dueTs: NOW + 3600000, now: NOW });   // still in grace
const openProm = rq.openByKind({ kind: 'promise', limit: 10, now: NOW });
ok('openByKind returns the due promise', openProm.some((r) => r.subject === 'roster#abc'));
ok('openByKind excludes a promise still in its grace window', !openProm.some((r) => r.subject === 'list#def'));
ok('openByKind is kind-scoped (no non-promise items)', openProm.every((r) => r.kind === 'promise'));
ok('openByKind carries the parsed detail (deliverable)', (openProm.find((r) => r.subject === 'roster#abc').detail || {}).deliverable === 'roster');
rq.complete(openProm.find((r) => r.subject === 'roster#abc').id, { outcome: 'surfaced-to-user', now: NOW });
ok('a surfaced promise is completed (leaves openByKind)', !rq.openByKind({ kind: 'promise', limit: 10, now: NOW }).some((r) => r.subject === 'roster#abc'));

const st = rq.stats();
ok('stats report open + kinds', st.open >= 1 && Array.isArray(st.byKind));

console.log(`smoke_recheck_queue: ${pass} passed, ${fail} failed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
