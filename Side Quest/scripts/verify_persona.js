const D = require('../lib/db'); D.init();
const ctx = require('../lib/context');
let pass = 0, fail = 0;
const ok = (n, c) => { (c ? pass++ : fail++); console.log(`  ${c ? '✓' : '✗'} ${n}`); };

const msgs = ctx.buildChatPrompt({
  userName: 'Lucas', recentReflections: [], recentTurns: [], recentMonologue: [], recentReadings: [],
  heldCommitments: [], openThreads: [], awareness: 'AWARE', protocols: [], browserBlock: null,
  pendingInbounds: [], retrievedKnowledgeBlock: null, capabilityProposalBlock: null,
  selfModelBlock: undefined, personalBlock: null, newUserMessage: 'hi'
});
const sys = msgs[0].content;

console.log('BASE PERSONA injected into chat prompt:');
ok('core header present', /ZOE LANE — YOUR CORE \(fixed/.test(sys));
ok('voice: flirty', /a little flirty/.test(sys));
ok('adult/worldly line', /WORLDLY & ADULT|adult or fantasy scenes/.test(sys));
ok('investigative drive', /YOU DIG/.test(sys));
ok('ambitions', /AMBITIONS \(long arc\)/.test(sys));
ok('self-improvement hard line', /self-improvement is paramount/.test(sys));
ok('boundaries-settled hard line', /once set, they are settled/.test(sys));
ok('memory marker line', /live in your memory/.test(sys));
ok('[user] substituted to Lucas', !/\[user\]/.test(sys) && /ask Lucas for it/.test(sys));
ok('self-model specifics also present (ranunculus)', /ranunculus/.test(sys));

console.log('\nNew seeds in self_model:');
const rows = D.getDb().prepare('SELECT category, content FROM self_model').all();
ok('short skirts / late-night seeded', rows.some(r => /short skirts/i.test(r.content)));
ok('fairness & equity seeded', rows.some(r => /fairness and equity/i.test(r.content)));
ok('connection seeded', rows.some(r => /connection/i.test(r.content)));
console.log(`  (self_model total: ${rows.length})`);

console.log(`\n${fail === 0 ? 'PERSONA WIRED OK' : 'SOME FAILURES'} — ${pass} passed, ${fail} failed`);
D.getDb().close();
process.exit(fail === 0 ? 0 : 1);
