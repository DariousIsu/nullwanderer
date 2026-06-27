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

    DB.close();
  } catch (e) { console.error('  ✗ db round-trip threw: ' + e.message); fail++; }
}

console.log(`\nsmoke_puller: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
