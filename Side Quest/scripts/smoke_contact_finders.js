'use strict';
/* smoke_contact_finders.js — pin the SINGLE finder source of truth: order, escalation, and person-build.
 * Offline: no network, no Echo. Run: ELECTRON_RUN_AS_NODE=1 <electron> scripts/smoke_contact_finders.js */
const assert = require('assert');
const path = require('path');
const { buildPerson, buildContactFinders } = require(path.join(__dirname, '..', 'lib', 'contact_finders'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.error('  FAIL:', name); } };

(async () => {
  // 1) Finder set + ORDER is the one contract every caller depends on.
  const { finders, escalate } = buildContactFinders({ webSearch: async () => ({ results: [] }), echoSuit: { dispatch: async () => ({ ok: false, text: '' }) }, fetchPage: async () => '' });
  ok('finders is an array of 4', Array.isArray(finders) && finders.length === 4);
  ok('finder order = pullerdb,pattern,hunter,web', finders.map(f => f.name).join(',') === 'pullerdb,pattern,hunter,web');
  ok('every finder has async run()', finders.every(f => typeof f.run === 'function'));
  ok('escalate is a function', typeof escalate === 'function');

  // 2) buildPerson resolves a seeded org domain offline (shared resolver seed map) + derives surname.
  const p = await buildPerson({ Name: 'John Kennedy', Org: 'LSU' }, { webSearch: async () => ({ results: [] }) });
  ok('person.name carried', p.name === 'John Kennedy');
  ok('surname derived', p.surname === 'Kennedy');
  ok('seeded org → domain (lsu.edu)', p.domain === 'lsu.edu');
  ok('query built for web finder', /email address/.test(p.query));

  // 3) An unresolvable org yields NO domain (never fabricated) → pattern/hunter safely self-disable.
  const p2 = await buildPerson({ Name: 'Jane Doe', Org: 'Totally Made Up Org QZX' }, { webSearch: async () => ({ results: [] }) });
  ok('unresolvable org → empty domain', p2.domain === '');
  const patt = await finders.find(f => f.name === 'pattern').run(p2);
  ok('pattern finder null without domain', patt === null);

  console.log(`\nsmoke_contact_finders: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('THREW:', e); process.exit(1); });
