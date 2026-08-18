'use strict';
// smoke_chain_guard.js — proves the echo-chain analysis+replan layer (lib/chain_guard.js):
//   - refuses exact repeats and REPLANS (does not stop) on no-progress;
//   - lets a productive chain keep its full budget;
//   - never trips on writes/builds;
//   - only forces an honest miss once the no-progress budget is spent.
// Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_chain_guard.js
const cg = require('../lib/chain_guard');

let fails = 0, passed = 0;
function ok(cond, msg) { if (!cond) { fails++; console.error('  ✗ ' + msg); } else { passed++; console.log('  ✓ ' + msg); } }

// ---- tagSignature: stable + normalized ----
ok(cg.tagSignature({ kind: 'recipe', name: 'contact-aliases', arg: 'Glen Womack' })
   === cg.tagSignature({ kind: 'recipe', name: 'Contact-Aliases', arg: '  glen womack ' }),
   'recipe signature is case/space-stable');
ok(cg.tagSignature({ kind: 'do', name: 'search_contacts', args: { query: 'a' } })
   !== cg.tagSignature({ kind: 'do', name: 'search_contacts', args: { query: 'b' } }),
   'do signature distinguishes different args');

// ---- tagLabel: human name for the tried-list ----
ok(cg.tagLabel({ kind: 'recipe', name: 'contact-aliases' }) === 'recipe contact-aliases', 'recipe label');
ok(cg.tagLabel({ kind: 'do', name: 'search_contacts' }) === 'search_contacts', 'do label');

// ---- isRetrievalTag: reads count, writes/builds do NOT ----
ok(cg.isRetrievalTag({ kind: 'recipe', name: 'entity-dossier' }), 'recipe is retrieval');
ok(cg.isRetrievalTag({ kind: 'do', name: 'db_query' }), 'db_query is retrieval');
ok(!cg.isRetrievalTag({ kind: 'do', name: 'saga_canvas_add_block' }), 'canvas write is NOT retrieval');
ok(!cg.isRetrievalTag({ kind: 'do', name: 'create_contact' }), 'create_contact is NOT retrieval');
ok(!cg.isRetrievalTag({ kind: 'propose', proposeKind: 'entity' }), 'propose is NOT retrieval');

// ---- REPEAT is refused and flagged, and counts as no-progress ----
{
  const st = cg.newState();
  const sig = cg.tagSignature({ kind: 'recipe', name: 'contact-aliases', arg: 'Glen Womack' });
  const h1 = cg.evaluateHop(st, { signature: sig, label: 'recipe contact-aliases', emptyThisHop: true, retrieval: true });
  ok(!h1.repeat && h1.needsReplan && !h1.exhausted, 'first empty run → replan, not a repeat, not exhausted');
  const h2 = cg.evaluateHop(st, { signature: sig, label: 'recipe contact-aliases', emptyThisHop: true, retrieval: true });
  ok(h2.repeat && h2.needsReplan, 'same recipe again → flagged repeat + needs replan');
}

// ---- REPLAN, not stop: distinct empty retrievals keep the chain alive until the ceiling ----
{
  const CEIL = 3;   // explicit small ceiling so the test is tight + decoupled from the default
  const st = cg.newState();
  let ev;
  for (let i = 0; i < CEIL - 1; i++) {
    ev = cg.evaluateHop(st, { signature: `recipe:r${i}:x`, label: `recipe r${i}`, emptyThisHop: true, retrieval: true }, CEIL);
    ok(ev.needsReplan && !ev.exhausted, `no-progress hop ${i + 1} → replan, not yet exhausted (ceiling ${CEIL})`);
  }
  ev = cg.evaluateHop(st, { signature: 'recipe:rN:x', label: 'recipe rN', emptyThisHop: true, retrieval: true }, CEIL);
  ok(ev.exhausted, `hop ${CEIL} of pure no-progress → exhausted (honest miss)`);
}
// Default ceiling honors "the full hop budget of different tries" (Lucas 08-18); main.js passes MAX_ECHO_HOPS.
ok(cg.NOPROGRESS_CEILING >= 12, 'default no-progress ceiling is the full hop budget (>=12)');

// ---- replanNote names what was tried and points at the web ----
{
  const st = cg.newState();
  cg.evaluateHop(st, { signature: 'recipe:contact-aliases:x', label: 'recipe contact-aliases', emptyThisHop: true, retrieval: true });
  cg.evaluateHop(st, { signature: 'recipe:entity-dossier:x', label: 'recipe entity-dossier', emptyThisHop: true, retrieval: true });
  const note = cg.replanNote(st, { userName: 'Lucas' });
  ok(/contact-aliases/.test(note) && /entity-dossier/.test(note), 'replan note lists the tried approaches');
  ok(/web_search|web-open/.test(note) && /Lucas/.test(note), 'replan note points at the web + names the user');
  const miss = cg.honestMissNote(st, { userName: 'Lucas' });
  ok(/STOP LOOPING/.test(miss) && /Lucas/.test(miss), 'honest-miss note is a hard stop naming the user');
}

// ---- PRODUCTIVE chain: real results reset the streak → never exhausts ----
{
  const st = cg.newState();
  for (let i = 0; i < 10; i++) {
    const ev = cg.evaluateHop(st, { signature: `do:step${i}:{}`, label: `step${i}`, emptyThisHop: false, retrieval: true });
    ok(!ev.exhausted, `productive hop ${i + 1} never exhausts`);
  }
}

// ---- WRITE/BUILD chain: empty + repeated writes never count or refuse ----
{
  const st = cg.newState();
  const a = cg.evaluateHop(st, { signature: 'do:saga_canvas_add_block:{"a":1}', label: 'saga_canvas_add_block', emptyThisHop: true, retrieval: false });
  const b = cg.evaluateHop(st, { signature: 'do:saga_canvas_add_block:{"a":2}', label: 'saga_canvas_add_block', emptyThisHop: true, retrieval: false });
  const c = cg.evaluateHop(st, { signature: 'do:saga_canvas_add_block:{"a":2}', label: 'saga_canvas_add_block', emptyThisHop: true, retrieval: false });
  ok(!a.needsReplan && !b.needsReplan && !c.needsReplan, 'empty write hops never need replan');
  ok(!c.repeat && !c.exhausted, 'a repeated write is not a retrieval repeat and never exhausts');
}

// ---- A real answer AFTER near-misses resets the streak ----
{
  const st = cg.newState();
  cg.evaluateHop(st, { signature: 'recipe:contact-aliases:x', label: 'recipe contact-aliases', emptyThisHop: true, retrieval: true });
  const good = cg.evaluateHop(st, { signature: 'do:web_search:{"query":"x"}', label: 'web_search', emptyThisHop: false, retrieval: false });
  ok(st.noProgress === 0 && !good.exhausted, 'progress hop resets the no-progress streak');
}

// Emit a runner-recognized verdict line ("N passed, M failed"); on success let the process exit
// naturally (no process.exit) so the line can't be truncated by the stdout pipe race.
console.log(`\nsmoke_chain_guard: ${passed} passed, ${fails} failed`);
if (fails) process.exit(1);
