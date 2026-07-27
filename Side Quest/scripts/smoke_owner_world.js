/* Smoke: lib/owner_world — the owner-world object store (KEYSTONE Slice 0). Proves the seed mints the
 * core (family + org + self), resolution wins on a bare first name (Alice → the daughter, the whole point),
 * a coordinate dereferences to its neighborhood, and seed is idempotent. Isolated temp DB (SQ_DB_PATH).
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_owner_world.js
 */
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = path.join(os.tmpdir(), `sq_ownerworld_${process.pid}_${Date.now().toString(36)}.db`);
try { fs.unlinkSync(tmp); } catch {}
process.env.SQ_DB_PATH = tmp;

const db = require('../lib/db'); db.init();
const ow = require('../lib/owner_world');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// ── seed mints the core ──────────────────────────────────────────────────────────────────────────
const r = ow.seed({});
ok(r.objects === 7 && r.edges === 8, 'seed: mints the 7 core objects + 8 edges (incl. LAMP)');
const n = db.getDb().prepare('SELECT COUNT(*) c FROM owner_world').get().c;
ok(n === 7, 'seed: rows landed in owner_world');

// ── resolution WINS on a bare first name (the Alice problem, solved) ──────────────────────────────
const alice = ow.resolve('Alice', {});
ok(alice && alice.status === 'resolved' && alice.object.id === 'person:owner/alice', 'resolve: bare "Alice" → the daughter coordinate, not a civic namesake');
ok(/cheer/i.test(alice.object.summary), 'resolve: the daughter object carries her real gloss (12, cheer)');
ok(ow.resolve('Zo', {}).object.id === 'self:zoe/core', 'resolve: "Zo" → Zoe self (alias), not a pet');
ok(ow.resolve('Jay', {}).object.id === 'person:owner/raegan', 'resolve: alias "Jay" → Raegan');
ok(ow.resolve('the Rainey Center', {}).object.id === 'org:work/rainey-center', 'resolve: multi-word alias with article');
ok(ow.resolve('Alicia Vermont', {}) === null, 'resolve: a non-owner name returns null → caller falls through to civic');
// LAMP (#41): a bare "LAMP" in his world → the Rainey-orbit network, NOT the civic namesake or the band.
ok(ow.resolve('LAMP', {}) && ow.resolve('LAMP', {}).object.id === 'org:work/lamp', 'resolve: bare "LAMP" → the owner-world network coordinate');
ok(ow.resolve('the LAMP network', {}) && ow.resolve('the LAMP network', {}).object.id === 'org:work/lamp', 'resolve: multi-word LAMP alias');
ok(/NOT the Japanese/i.test(ow.resolve('LAMP', {}).object.summary), 'resolve: the LAMP summary explicitly disambiguates from the band confab');
{
  const lamp = ow.get('org:work/lamp');
  const lrels = new Set((lamp.edges || []).map(e => `${e.rel}:${e.src === 'org:work/lamp' ? e.dst : e.src}`));
  ok([...lrels].some(x => x === 'MEMBER_OF:person:owner/lucas'), 'get: LAMP → Lucas MEMBER_OF edge ("in the LAMP rolls")');
  ok([...lrels].some(x => x === 'RUNS:org:work/rainey-center'), 'get: LAMP ← Rainey Center RUNS edge');
}

// ── a coordinate dereferences to its NEIGHBORHOOD ────────────────────────────────────────────────
const lucas = ow.get('person:owner/lucas', {});
ok(lucas && lucas.name === 'Lucas Overby', 'get: coordinate → the object');
const rels = new Set(lucas.edges.map(e => `${e.rel}:${e.dst === 'person:owner/lucas' ? e.src : e.dst}`));
ok(lucas.edges.length >= 4, 'get: Lucas dereferences his whole neighborhood (kids, org, team, companion)');
ok([...rels].some(x => x.startsWith('PARENT_OF:person:owner/alice')), 'get: the parent_of→Alice edge is present');
const zoe = ow.get('self:zoe/core', {});
ok(zoe.edges.some(e => e.rel === 'COMPANION_OF' && e.dst === 'person:owner/lucas'), 'get: Zoe self → companion_of Lucas');

// ── seed is idempotent (safe to run every boot) ──────────────────────────────────────────────────
ow.seed({});
ok(db.getDb().prepare('SELECT COUNT(*) c FROM owner_world').get().c === 7, 'seed: idempotent — no duplicate objects on re-seed');
ok(db.getDb().prepare('SELECT COUNT(*) c FROM owner_world_edges').get().c === 8, 'seed: idempotent — no duplicate edges');

try { fs.unlinkSync(tmp); } catch {}
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
