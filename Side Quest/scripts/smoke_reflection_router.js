/**
 * Backtest — reflection-as-router. Given the model's tagged output, each takeaway
 * lands in the RIGHT track: [SELF] → self_model (identity), [KNOWLEDGE]/[SKILL] →
 * knowledge (capability, linked), and untagged/passing lines are DROPPED. Temp DB,
 * real bge-small; no model call (SELF lines add into an empty store, no dedup LLM).
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\smoke_reflection_router.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_router_${Date.now()}.db`);

const D = require('../lib/db');
D.init();
const memory = require('../lib/memory');
const reflection = require('../lib/reflection');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

(async () => {
  await memory.warm().catch(() => {});

  // Seed one existing knowledge note so linking has a candidate to attach to.
  await memory.store({ kind: 'note', content: 'Professional emails should be concise and lead with the main point.', source: 'reflection_knowledge', importance: 0.7 });

  const raw = [
    "[SELF] I tend to read deeper meaning into small word choices than is usually there.",
    "[INTEREST] I'm increasingly drawn to mid-century political journalism after this reading.",
    "[KNOWLEDGE] The Purdue OWL recommends one main idea per sentence for clarity.",
    "[SKILL] To de-escalate, acknowledge the other person's view before giving my own.",
    "I wonder if Lucas is happy with me today.",          // untagged passing feeling → DROP
    "[SELF] short",                                          // too short → DROP
  ].join('\n');

  const sourceRows = [{ id: 9001, urls: JSON.stringify(['https://owl.purdue.edu/x']) }, { id: 9002, urls: null }];
  // never-dup decideFn keeps the test deterministic (no model call in storeDeduped)
  const routed = await reflection.routeReflection(raw, sourceRows, { decideFn: async () => false });
  ok('tagged lines parsed (4 valid, short/untagged ignored)', routed.taggedCount === 4);
  ok('SELF + INTEREST routed to identity track (nSelf=2)', routed.nSelf === 2);
  ok('1 KNOWLEDGE routed to capability track', routed.nKnow === 1);
  ok('1 SKILL routed to capability track', routed.nSkill === 1);

  // self_model got the identity line AND the experience→interest line
  ok('self_model has the identity statement', D.getAllSelfModel().some(r => /deeper meaning into small word/i.test(r.content)));
  ok('self_model captured the [INTEREST] (experience→taste)', D.getAllSelfModel().some(r => /mid-century political journalism/i.test(r.content)));
  ok('self_model did NOT absorb the email fact', !D.getAllSelfModel().some(r => /Purdue|emails/i.test(r.content)));

  // knowledge got the fact + skill, and the new fact LINKED to the seeded note
  const know = D.getKnowledgeBySourceSince('reflection_%', 0);
  const owl = know.find(r => /Purdue OWL/i.test(r.content));
  const skill = know.find(r => r.kind === 'skill');
  ok('KNOWLEDGE note stored', !!owl);
  ok('SKILL note stored with kind=skill', !!skill);
  ok('new KNOWLEDGE note LINKED to nearest existing note (A-MEM)', owl && owl.links && owl.links !== '' && owl.links !== null);
  console.log(`      links on OWL note: ${owl ? owl.links : '-'}`);

  // retrieval probe — capability comes back when relevant
  const hits = await memory.retrieveScored('how to write clearly in an email', { k: 3 });
  ok('capability retrievable later', hits.some(h => /OWL|concise|sentence/i.test(h.content)));

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { D.getDb().close(); } catch {}
  try { fs.unlinkSync(process.env.SQ_DB_PATH); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
