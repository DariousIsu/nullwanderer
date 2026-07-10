/* scripts/smoke_puller_revise.js — the negative-signal loop on one dossier (in-memory db).
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_puller_revise.js */
'use strict';
const DB = require('../lib/puller_db');
const B = require('../studio/puller_beliefs');
const R = require('../studio/puller_revise');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.error('  ✗ ' + name); } }

DB.init({ path: ':memory:' });

// seed: a pattern-confirmed (grade C, 80%) contact at acme.com, holding first.last
const t = DB.createTarget({ name: 'Brian Huseman', company: 'Acme', domain: 'acme.com' });
DB.addObservation(t.id, { attr: 'email', value: 'brian.huseman@acme.com', kind: 'pattern', source: 'seed' });
DB.upsertBelief(t.id, 'email', { value: 'brian.huseman@acme.com', confidence: 0.80, derivation: 'seed' });
// seed pattern state so first.last is currently believed (a couple hits)
let st = B.updateBelief(B.updateBelief(B.emptyState(), 'first.last', 'valid'), 'first.last', 'valid');
DB.savePatternState('acme.com', st);

// ---- 1. negative on the held value → conflict + proposed flip + retest ----
const neg = R.applyVerification(t.id, { value: 'brian.huseman@acme.com', result: 'invalid' });
ok('bounce dropped confidence to NEG_CAP', neg.confidence === 0.20);
ok('bounce recorded an observation', neg.observationId > 0);
ok('flip proposed', neg.revisionId > 0 && neg.patternFlip && neg.patternFlip.fromPattern === 'first.last');
ok('next pattern is flast', neg.patternFlip.toPattern === 'flast' && neg.patternFlip.to === 'bhuseman@acme.com');
ok('retest enqueued', neg.retestId > 0 && DB.listRetests({ status: 'queued' }).some(q => q.next_pattern === 'flast'));
ok('first.last took a miss', DB.getPatternState('acme.com').patterns['first.last'].misses === 1);
ok('belief now marked conflict', /conflict/.test(DB.getBelief(t.id, 'email').derivation));
ok('MARKER: bounce-with-flip → send_state=bounced', DB.getBelief(t.id, 'email').send_state === 'bounced');

// ---- 2. accept the flip → new held value, re-qualified as a fresh derived guess (D = 50%) ----
const dec = R.decideRevision(neg.revisionId, 'accepted');
ok('revision applied', dec.applied === true);
ok('held value flipped to flast candidate', DB.getBelief(t.id, 'email').value === 'bhuseman@acme.com');
ok('new value qualifies at D (50%)', dec.confidence === 0.50 && dec.grade === 'D');
ok('no longer pending', DB.listRevisions({ status: 'pending' }).length === 0);
ok('MARKER: accepted flip → send_state=rerun_pending', DB.getBelief(t.id, 'email').send_state === 'rerun_pending');
ok('rerun batch surfaces it (listBeliefsBySendState)', DB.listBeliefsBySendState({ sendState: 'rerun_pending' }).some(b => b.target_id === t.id));

// ---- 3. verify the new candidate VALID → climbs to B (95%) + credits flast ----
const pos = R.applyVerification(t.id, { value: 'bhuseman@acme.com', result: 'valid' });
ok('valid lifts to 95% (grade B)', pos.confidence === 0.95 && pos.grade === 'B');
ok('flast credited a hit', DB.getPatternState('acme.com').patterns.flast.hits === 1);
ok('no flip proposed on a positive', pos.revisionId === null);
ok('MARKER: verified send → send_state=verified', DB.getBelief(t.id, 'email').send_state === 'verified');
ok('verified list surfaces it', DB.listBeliefsBySendState({ sendState: 'verified' }).some(b => b.target_id === t.id));

// ---- 4. dedicated source (business card) → 100% (only A reaches full) ----
const ded = R.markDedicatedSource(t.id, { value: 'b.huseman@acme.com', note: 'business card, conf 2026' });
ok('dedicated source → 100%', ded.confidence === 1.00 && ded.grade === 'A');
ok('held value is the card address', DB.getBelief(t.id, 'email').value === 'b.huseman@acme.com');

// ---- 5. catch-all gating: accept_all marks domain + suppresses flips ----
const t2 = DB.createTarget({ name: 'Jane Roe', company: 'CatchCo', domain: 'catchco.com' });
DB.addObservation(t2.id, { attr: 'email', value: 'jane.roe@catchco.com', kind: 'pattern' });
DB.upsertBelief(t2.id, 'email', { value: 'jane.roe@catchco.com', confidence: 0.80 });
const ca = R.applyVerification(t2.id, { value: 'jane.roe@catchco.com', result: 'accept_all' });
ok('accept_all flags catch-all', ca.catchAll === true && B.isCatchAll(DB.getPatternState('catchco.com')));
const caNeg = R.applyVerification(t2.id, { value: 'jane.roe@catchco.com', result: 'invalid' });
ok('no flip proposed on catch-all domain', caNeg.revisionId === null);
ok('MARKER: catch-all domain → send_state=catchall', DB.getBelief(t2.id, 'email').send_state === 'catchall');

// ---- 6. gateway-block: a strong-prior domain that only bounces → infra-suspect, no flip ----
const ti = DB.createTarget({ name: 'Block Person', company: 'MSFT', domain: 'msft.com' });
DB.addObservation(ti.id, { attr: 'email', value: 'block.person@msft.com', kind: 'pattern' });
DB.upsertBelief(ti.id, 'email', { value: 'block.person@msft.com', confidence: 0.80 });
DB.savePatternState('msft.com', B.seedPrior(B.emptyState(), 'first.last', 0.7));   // a domain we trusted
let infraRes;
for (let i = 0; i < 3; i++) infraRes = R.applyVerification(ti.id, { value: 'block.person@msft.com', result: 'invalid' });
ok('3rd bounce on strong-prior domain → infraSuspect', infraRes.infraSuspect === true);
ok('infra-suspect proposes NO flip', infraRes.revisionId === null && infraRes.patternFlip === null);
ok('MARKER: exhausted (bounce, no reachable flip) → send_state=exhausted', DB.getBelief(ti.id, 'email').send_state === 'exhausted');

// ---- 7. cascade: a domain belief shift re-derives queued retests' next pattern ----
DB.savePatternState('acme.com', B.seedPrior(B.emptyState(), 'f.last', 0.9));        // f.last now dominant
const rid = DB.enqueueRetest({ targetId: t.id, person: 'Brian Huseman', domain: 'acme.com', patternsTried: ['first.last'], nextPattern: 'flast' });
const casc = R.cascadeForDomain('acme.com');
ok('cascade re-derives stale next-pattern → f.last', casc.some(c => c.id === rid && c.to === 'f.last'));
ok('cascade persisted the new next_pattern', (DB.listRetests({ status: 'queued' }).find(r => r.id === rid) || {}).next_pattern === 'f.last');

DB.close();
console.log(`\nsmoke_puller_revise: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
