/* Smoke: lib/known — KNOWN→UNKNOWN grounding. Proves the foundation block is assembled from our own
 * sources and prepended as a gap-only directive (build on what we hold, don't redo it). Pure. Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_known.js
 */
'use strict';
const k = require('../lib/known');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const block = k.buildKnownBlock({
  entity: 'Hudson Institute',
  existing: '## Hudson Institute\n- Key people: John Walters — CEO\n- Contact: not found',
  local: ['Lucas noted Hudson focuses on defense policy', ''],
  echo: ['entity: Hudson Institute (org) — linked to 3 people', 'kb: Hudson 990 revenue $40M']
});
ok(/OUR EXISTING RECORD on Hudson Institute/.test(block), 'includes the existing dossier record');
ok(/FROM ZOE'S MEMORY/.test(block) && /defense policy/.test(block), "includes Zoe's memory hits");
ok(/FROM OUR ECHO DATABASES/.test(block) && /990 revenue/.test(block), 'includes Echo DB hits');
ok(k.hasKnown(block) === true, 'hasKnown true for a real block');

ok(k.buildKnownBlock({}) === '', 'empty inputs → empty block');
ok(k.hasKnown('') === false, 'hasKnown false for empty');
ok(k.buildKnownBlock({ entity: 'X', local: [''], echo: [' '] }) === '', 'only-empty hits → empty block');

const g = k.gapDirective('Hudson Institute', 'as many contacts as possible');
ok(/KNOWN→UNKNOWN/.test(g) && /Hudson Institute/.test(g) && /as many contacts/.test(g) && /do NOT re-gather/i.test(g), 'gapDirective names entity + facet + forbids redoing');

// withKnown: prepends known + directive when present; no-op when absent
const body = 'RESEARCH PROMPT BODY';
const wrapped = k.withKnown(body, { knownBlock: block, entity: 'Hudson Institute', facet: 'contacts' });
ok(/WHAT WE ALREADY KNOW/.test(wrapped) && /KNOWN→UNKNOWN/.test(wrapped) && wrapped.endsWith(body), 'withKnown prepends foundation + directive, keeps the body');
ok(k.withKnown(body, { knownBlock: '' }) === body, 'withKnown is a no-op when nothing is known');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
