/* scripts/smoke_puller.js — Slice 0 offline checks: belief math (pure) + dossier store (in-memory db).
 * Pure-math assertions run under plain node; the DB half needs Electron's node (better-sqlite3 ABI):
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_puller.js
 */
'use strict';
const B = require('../studio/puller_beliefs');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.error('  ✗ ' + name); } }
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ---- §3 email derivation -------------------------------------------------------------------------
ok('derive first.last', B.deriveEmail('Brian Huseman', 'amazon.com', 'first.last') === 'brian.huseman@amazon.com');
ok('derive flast', B.deriveEmail('Brian Huseman', 'amazon.com', 'flast') === 'bhuseman@amazon.com');
ok('derive f.last', B.deriveEmail('Brian Huseman', 'entergy.com', 'f.last') === 'b.huseman@entergy.com');
ok('derive firstlast', B.deriveEmail('Brian Huseman', 'google.com', 'firstlast') === 'brianhuseman@google.com');
ok('derive first', B.deriveEmail('Josh Levi', 'datacentercoalition.org', 'first') === 'josh@datacentercoalition.org');
ok('derive last.first', B.deriveEmail('Brian Huseman', 'x.com', 'last.first') === 'huseman.brian@x.com');
ok('unknown pattern falls back to first.last', B.deriveEmail('Brian Huseman', 'x.com', 'weird') === 'brian.huseman@x.com');
ok('strips generational suffix', B.deriveEmail('John Smith Jr', 'x.com', 'first.last') === 'john.smith@x.com');
ok('strips apostrophe', B.deriveEmail("Brian O'Neil", 'x.com', 'flast') === 'boneil@x.com');
// credential/honorific stripping (the "sean.ph.d.@…" bug)
ok('strips post-nominal credential (Ph.D.)', B.deriveEmail('Sean I. Plasynski, Ph.D.', 'hq.doe.gov', 'first.last') === 'sean.plasynski@hq.doe.gov');
ok('strips leading honorific (Dr.)', B.deriveEmail('Dr. Kam Ghaffarian', 'x-energy.com', 'first.last') === 'kam.ghaffarian@x-energy.com');
ok('strips comma + MD', B.deriveEmail('Jane Roe, MD', 'x.com', 'flast') === 'jroe@x.com');
ok('mononym not derivable → empty', B.deriveEmail('Cher', 'x.com', 'first.last') === '');
ok('no domain → empty', B.deriveEmail('Brian Huseman', '', 'first.last') === '');

// ---- §4.6 detectPatternUsed (reverse) ------------------------------------------------------------
ok('detect flast from email', B.detectPatternUsed('bhuseman@amazon.com', 'Brian Huseman', 'amazon.com') === 'flast');
ok('detect first.last from email', B.detectPatternUsed('brian.huseman@amazon.com', 'Brian Huseman', 'amazon.com') === 'first.last');
ok('detect none when no pattern matches', B.detectPatternUsed('xyz@amazon.com', 'Brian Huseman', 'amazon.com') === null);

// ---- §4.3 Bayesian belief math -------------------------------------------------------------------
const empty = B.emptyState();
ok('empty belief = default prior', approx(B.currentBelief(empty, 'first.last'), B.DEFAULT_PRIOR));
ok('bestPattern on empty = first priority', B.bestPattern(empty) === 'first.last');

const seeded = B.seedPrior(empty, 'flast', 0.7);
ok('seeded prior reads back as 0.70 (Beta(7,3))', approx(B.currentBelief(seeded, 'flast'), 0.7));
ok('purity: seeding did not mutate empty', Object.keys(empty.patterns).length === 0);
ok('seeded flast now beats first.last', B.bestPattern(seeded) === 'flast');

const afterHit = B.updateBelief(seeded, 'flast', 'valid');
ok('hit raises belief 7/10 → 8/11', approx(B.currentBelief(afterHit, 'flast'), 8 / 11));
const afterMiss = B.updateBelief(seeded, 'flast', 'invalid');
ok('miss lowers belief 7/10 → 7/11', approx(B.currentBelief(afterMiss, 'flast'), 7 / 11));
ok('unknown result = no change', approx(B.currentBelief(B.updateBelief(seeded, 'flast', 'unknown'), 'flast'), 0.7));

// catch-all flips the domain flag
const ca = B.updateBelief(empty, 'first.last', 'accept_all');
ok('accept_all marks catch-all', B.isCatchAll(ca) === true && B.isCatchAll(empty) === false);

// ---- §4.4 r3 pattern abandonment -----------------------------------------------------------------
let dead = empty;
for (let i = 0; i < 3; i++) dead = B.updateBelief(dead, 'firstlast', 'invalid');
ok('3 misses → pattern dead', B.isPatternDead(dead, 'firstlast') === true);
ok('not-yet-missed pattern not dead', B.isPatternDead(dead, 'first.last') === false);

// ---- §4.9 bestUnusedPattern --------------------------------------------------------------------
ok('bestUnused excludes tried', B.bestUnusedPattern(seeded, ['flast']) === 'first.last');
ok('bestUnused null when all tried', B.bestUnusedPattern(empty, B.PATTERN_PRIORITY) === null);

// ---- v2: expanded pattern menu (11 templates) + middle names ----
ok('derive first_last (underscore)', B.deriveEmail('Brian Huseman', 'x.com', 'first_last') === 'brian_huseman@x.com');
ok('derive bare last', B.deriveEmail('Brian Huseman', 'x.com', 'last') === 'huseman@x.com');
ok('nameParts extracts middle', B.nameParts('Mark Allen Miller').middle === 'allen');
ok('derive firstm.last', B.deriveEmail('Mark Allen Miller', 'aes.com', 'firstm.last') === 'marka.miller@aes.com');
ok('derive first.m.last', B.deriveEmail('Mark Allen Miller', 'aes.com', 'first.m.last') === 'mark.a.miller@aes.com');
ok('derive first.middle.last', B.deriveEmail('Mark Allen Miller', 'aes.com', 'first.middle.last') === 'mark.allen.miller@aes.com');
ok('middle pattern → "" when no middle', B.deriveEmail('Brian Huseman', 'x.com', 'firstm.last') === '');
ok('detect first_last reverse', B.detectPatternUsed('brian_huseman@x.com', 'Brian Huseman', 'x.com') === 'first_last');

// ---- v2: nextCandidate (skips non-derivable patterns) ----
const nc1 = B.nextCandidate(empty, 'Brian Huseman', 'x.com', ['first.last']);
ok('nextCandidate picks next derivable (flast)', nc1 && nc1.pattern === 'flast' && nc1.email === 'bhuseman@x.com');
const nc2 = B.nextCandidate(empty, 'Brian Huseman', 'x.com', ['first.last', 'flast', 'f.last', 'firstlast', 'first_last', 'last.first']);
ok('nextCandidate skips middle patterns for 2-token name → first', nc2 && nc2.pattern === 'first');

// ---- v2: gateway-block (infra) detector ----
let infra = B.seedPrior(empty, 'first.last', 0.7);     // a domain we were confident about
for (let i = 0; i < 3; i++) infra = B.updateBelief(infra, 'first.last', 'invalid');
ok('strong prior + only bounces → infra-blocked', B.looksInfraBlocked(infra) === true);
ok('a hit clears infra suspicion', B.looksInfraBlocked(B.updateBelief(infra, 'first.last', 'valid')) === false);
ok('weak-prior bounces are NOT infra', B.looksInfraBlocked(dead) === false);   // firstlast 3 misses, default prior

console.log(`\nmath: ${pass} passed, ${fail} failed (so far)`);

// ---- DB round-trip (needs better-sqlite3 / Electron node) ----------------------------------------
let DB;
try { DB = require('../lib/puller_db'); } catch (e) { console.error('  ✗ load puller_db: ' + e.message); fail++; }
if (DB) {
  try {
    DB.init({ path: ':memory:' });

    // targets + promote
    const t = DB.createTarget({ name: 'Brian Huseman', company: 'Amazon', domain: 'amazon.com', function: 'GR' });
    ok('createTarget round-trips', t && t.id > 0 && t.status === 'adhoc' && t.crm_id == null);
    ok('listTargets finds it', DB.listTargets({ status: 'adhoc' }).some(r => r.id === t.id));
    const promoted = DB.promoteTarget(t.id, 'crm-123');
    ok('promoteTarget sets crm + status', promoted.status === 'promoted' && promoted.crm_id === 'crm-123');

    // observations (append-only)
    const o1 = DB.addObservation(t.id, { attr: 'email', value: 'brian.huseman@amazon.com', kind: 'derived', confidence: 0.7 });
    DB.addObservation(t.id, { attr: 'email', value: 'bhuseman@amazon.com', kind: 'verify', meta: { raw: 'valid' } });
    const obs = DB.listObservations(t.id, { attr: 'email' });
    ok('observations append (2) in order', obs.length === 2 && obs[0].id === o1);
    ok('observation meta json round-trips', obs[1].meta && obs[1].meta.raw === 'valid');

    // beliefs (unique per type — upsert, not duplicate)
    DB.upsertBelief(t.id, 'email', { value: 'brian.huseman@amazon.com', confidence: 0.7, supportingObs: [o1] });
    DB.upsertBelief(t.id, 'email', { value: 'bhuseman@amazon.com', confidence: 0.9, supportingObs: [o1] });
    const bel = DB.getBelief(t.id, 'email');
    ok('belief upsert updates in place', bel.value === 'bhuseman@amazon.com' && bel.confidence === 0.9);
    ok('belief supporting_obs json round-trips', Array.isArray(bel.supporting_obs) && bel.supporting_obs[0] === o1);
    ok('listBeliefs returns one row', DB.listBeliefs(t.id).length === 1);

    // pattern beliefs (bridge: persist the pure state)
    let st = B.emptyState();
    st = B.updateBelief(st, 'flast', 'valid');
    DB.savePatternState('amazon.com', st);
    const got = DB.getPatternState('amazon.com');
    ok('pattern state persists + reloads', got.patterns.flast && got.patterns.flast.hits === 1);
    ok('belief math works on reloaded state', approx(B.currentBelief(got, 'flast'), B.currentBelief(st, 'flast')));
    ok('unknown domain → empty state', DB.getPatternState('nowhere.com').patterns && Object.keys(DB.getPatternState('nowhere.com').patterns).length === 0);

    // revisions (propose → approve gate)
    const rev = DB.proposeRevision({ subjectKind: 'pattern', subjectRef: 'amazon.com', attr: 'email_pattern',
      fromValue: 'first.last', toValue: 'flast', triggerObsId: o1, rationale: 'first.last bounced; flast verified' });
    ok('proposeRevision pending', DB.listRevisions({ status: 'pending' }).some(r => r.id === rev));
    const decided = DB.decideRevision(rev, 'accepted');
    ok('decideRevision accepts', decided.status === 'accepted' && decided.decided_at > 0);
    ok('no longer pending', DB.listRevisions({ status: 'pending' }).length === 0);

    // retest queue (§4.5)
    const rq = DB.enqueueRetest({ targetId: t.id, person: 'Brian Huseman', domain: 'amazon.com',
      patternsTried: ['first.last'], nextPattern: 'flast', previousAttempts: [{ email: 'brian.huseman@amazon.com', result: 'invalid' }] });
    const queued = DB.listRetests({ status: 'queued' });
    ok('retest enqueues + json round-trips', queued.length === 1 && queued[0].patterns_tried[0] === 'first.last' && queued[0].previous_attempts[0].result === 'invalid');
    const upd = DB.updateRetest(rq, { status: 'verified' });
    ok('updateRetest moves status', upd.status === 'verified' && DB.listRetests({ status: 'queued' }).length === 0);

    // ---- Slice 1 aggregator (lib/puller_ipc.buildDossier) over the same in-memory db ----
    const IPC = require('../lib/puller_ipc');
    // a fresh pending belief revision + queued retest so the dossier surfaces them
    DB.proposeRevision({ subjectKind: 'belief', subjectRef: '1', targetId: t.id, attr: 'role',
      fromValue: 'VP GA', toValue: 'SVP GA', rationale: 'press release lists SVP' });
    DB.enqueueRetest({ targetId: t.id, person: 'Brian Huseman', domain: 'amazon.com',
      patternsTried: ['first.last'], nextPattern: 'flast' });
    const dos = IPC.buildDossier(t.id);
    ok('buildDossier returns target identity', dos && dos.target && dos.target.id === t.id);
    ok('buildDossier joins observations + beliefs', dos.observations.length === 2 && dos.beliefs.length === 1);
    ok('buildDossier surfaces pending revision', dos.revisions.some(r => r.attr === 'role' && r.status === 'pending'));
    ok('buildDossier surfaces queued retest', dos.retests.length === 1 && dos.retests[0].next_pattern === 'flast');
    ok('buildDossier domainPattern ranks best first', dos.domainPattern && dos.domainPattern.patterns[0].belief >= dos.domainPattern.patterns[1].belief);
    ok('buildDossier flags the best pattern', dos.domainPattern.patterns.some(p => p.best === true));
    ok('buildDossier null for unknown target', IPC.buildDossier(99999) === null);
    ok('domainPatternView null without domain', IPC.domainPatternView(null) === null);
    ok('listTargets returns trimmed rows', IPC.listTargets({}).some(r => r.id === t.id && r.name === 'Brian Huseman'));

    DB.close();
  } catch (e) { console.error('  ✗ db round-trip threw: ' + e.message); fail++; }
}

console.log(`\nsmoke_puller: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
