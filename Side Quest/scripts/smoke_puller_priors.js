/* scripts/smoke_puller_priors.js — offline checks for prior seeding (in-memory db).
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_puller_priors.js */
'use strict';
const DB = require('../lib/puller_db');
const B = require('../studio/puller_beliefs');
const P = require('../studio/puller_priors');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.error('  ✗ ' + name); } }
const approx = (a, b, e = 1e-9) => Math.abs(a - b) < e;

DB.init({ path: ':memory:' });

const stats = P.seedInto(DB);
ok('seeded many domains/patterns', stats.domains >= 25 && stats.patterns >= stats.domains);

// priors land + drive bestPattern
const aep = DB.getPatternState('aep.com');
ok('aep.com flast prior 0.70', approx(B.currentBelief(aep, 'flast'), 0.70) && B.bestPattern(aep) === 'flast');
ok('gm.com first.last ~0.99', approx(B.currentBelief(DB.getPatternState('gm.com'), 'first.last'), 0.99));
ok('amazon.com best = flast', B.bestPattern(DB.getPatternState('amazon.com')) === 'flast');
ok('unknown domain stays default', Object.keys(DB.getPatternState('nowhere.com').patterns).length === 0);

// merge preserves observed hits/misses
DB.savePatternState('aep.com', B.updateBelief(DB.getPatternState('aep.com'), 'flast', 'valid'));
P.seedInto(DB);   // re-seed
ok('re-seed preserves the observed hit', (DB.getPatternState('aep.com').patterns.flast.hits) === 1);
ok('re-seed keeps prior (not doubled)', approx(DB.getPatternState('aep.com').patterns.flast.prior, 0.70));

// seeding activates the gateway-block detector for a strong-prior domain that only bounces
let ms = DB.getPatternState('microsoft.com');
for (let i = 0; i < 3; i++) ms = B.updateBelief(ms, 'first.last', 'invalid');
ok('seeded hyperscaler + 3 bounces → infra-blocked', B.looksInfraBlocked(ms) === true);

DB.close();
console.log(`\nsmoke_puller_priors: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
