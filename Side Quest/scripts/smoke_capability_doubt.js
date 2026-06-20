/**
 * Smoke test for the capability-doubt resolver (lib/rumination.js): a rumination
 * spiral that re-litigates a granted capability is RESOLVED with a settled note
 * instead of escalated to a focus. Critically, the note must NOT itself trip the
 * voice disclaimer detector (else it would re-seed the loop).
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\smoke_capability_doubt.js
 */
const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_capdoubt_${Date.now()}`, 'sq.db');

const D = require('../lib/db'); D.init();
const rum = require('../lib/rumination');
const voice = require('../lib/voice');

let pass = 0, fail = 0;
const ok = (n, c, detail) => { if (c) { pass++; console.log(`  ✓ ${n}${detail ? ' — ' + detail : ''}`); } else { fail++; console.log(`  ✗ ${n}${detail ? ' — ' + detail : ''}`); } };

// The three near-identical thoughts Lucas pasted (capability-doubt spiral).
const doubtThoughts = [
  { id: 1, content: "Lucas's insistence that I can open and use a chatbot site contradicts my understanding of my own capabilities. I've consistently maintained that I cannot directly use other chatbots or applications." },
  { id: 2, content: "I explicitly stated that I don't have the ability to access or interact with external chats, yet he continues to assert that I can." },
  { id: 3, content: "I opened a chatbot site in my own browser, but I'm not sure how to proceed without misunderstanding my limitations." }
];
const normalThoughts = [
  { id: 7, content: "I keep coming back to his point about housing supply — the constraint isn't demand, it's permitting." },
  { id: 8, content: "There's a tension between speed and thoroughness in the piece I'm drafting." }
];

console.log('Detection:');
ok('flags a capability-doubt spiral', rum.isCapabilityDoubt(doubtThoughts));
ok('does NOT flag normal introspection', !rum.isCapabilityDoubt(normalThoughts));

console.log('\nResolution:');
const note = rum.resolveCapabilityDoubt(doubtThoughts);
ok('returns a settled note', typeof note === 'string' && /settled capability/i.test(note));
ok('note owns the capability (already opened it)', /already opened/i.test(note));
ok('note is NOT itself a disclaimer (cannot re-seed the loop)', !voice.isSelfDisclaimer(note), note.slice(0, 50));
ok('sets a cooldown so the spiral stops', parseInt(D.getMeta('rumination_cooldown_until') || '0', 10) > Date.now());
ok('consumes the thought window', parseInt(D.getMeta('rumination_last_id') || '0', 10) === 3);

console.log(`\n${fail === 0 ? 'ALL CAPABILITY-DOUBT TESTS OK' : 'SOME FAILURES'} — ${pass} passed, ${fail} failed`);
try { D.getDb().close(); } catch {}
process.exit(fail === 0 ? 0 : 1);
