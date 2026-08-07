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

const st = rq.stats();
ok('stats report open + kinds', st.open >= 1 && Array.isArray(st.byKind));

console.log(`smoke_recheck_queue: ${pass} passed, ${fail} failed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
