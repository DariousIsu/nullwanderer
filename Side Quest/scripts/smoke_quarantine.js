/**
 * Hard smoke — follow-up #1: quarantine existing laundered facts.
 * A reflection fact grounded in a real external URL is KEPT; one with no clean external
 * source (no URL, or only DuckDuckGo self-searches) is DEMOTED to reflection_speculation and
 * vanishes from recall. Non-reflection facts are untouched. Offline, real embedder.
 */
const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_quar_${Date.now()}`, 'sq.db');
const db = require('../lib/db'); db.init();
const memory = require('../lib/memory');
const mig = require('./migrate_quarantine_laundered');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };
const prov = (urls) => [{ type: 'reflection', refTable: 'monologue', refId: 1, refIds: [1], urls, label: 'distilled from recent thoughts/readings' }];

(async () => {
  console.log('Hard smoke — #1 quarantine laundered facts\n');
  await memory.warm();

  const G = await memory.store({ kind: 'note', content: "DuckDuckGo's HTML results list each title under a.result__a.", source: 'reflection_knowledge', importance: 0.75, provenance: prov(['https://html.duckduckgo.com/html/', 'https://www.example.com/ddg-guide']) });
  const L1 = await memory.store({ kind: 'note', content: 'The Coast Guard AI superhighway could streamline Salesforce integration.', source: 'reflection_knowledge', importance: 0.75, provenance: prov(['https://html.duckduckgo.com/html/?q=this+could+be+a+unique+angle+for+my+article+series']) });
  const L3 = await memory.store({ kind: 'note', content: 'Immersive storytelling connects to my Salesforce dedup work.', source: 'reflection_knowledge', importance: 0.75, provenance: prov(['https://html.duckduckgo.com/html/?q=I+keep+thinking+immersive+storytelling+could+make+this+engaging']) });
  const N = await memory.store({ kind: 'note', content: 'Margaret Bourke-White was a pioneering photojournalist.', source: 'reflection_knowledge', importance: 0.75, provenance: prov([]) });            // no URL — real fact, can't prove laundering → KEEP
  const T = await memory.store({ kind: 'note', content: 'FAST-41 created predictable federal permitting timelines.', source: 'reflection_knowledge', importance: 0.75, provenance: prov(['https://html.duckduckgo.com/html/?q=FAST-41+federal+permitting+timelines']) }); // real-topic search → KEEP
  const U = await memory.store({ kind: 'note', content: 'Lucas prefers black coffee.', source: 'manual', importance: 0.6 });

  console.log('detector (precise: self-fragment search, not merely no-URL):');
  const byId = (id) => db.getKnowledgeByIds([id])[0];
  ok('grounded reflection fact (real URL) → NOT laundered', mig.isLaundered(byId(G.id)) === false);
  ok('self-fragment search, no real source → laundered', mig.isLaundered(byId(L1.id)) === true);
  ok('second self-fragment search → laundered', mig.isLaundered(byId(L3.id)) === true);
  ok('no-URL real fact → KEPT (no false positive)', mig.isLaundered(byId(N.id)) === false);
  ok('real-topic search → KEPT', mig.isLaundered(byId(T.id)) === false);
  ok('non-reflection (manual) fact → not a candidate', mig.isLaundered(byId(U.id)) === false);

  const before = mig.scan();
  ok('scan finds exactly 2 laundered', before.laundered.length === 2);

  console.log('\napply (demote):');
  const n = mig.apply();
  ok('demoted 2', n === 2);
  ok('L1 now reflection_speculation @ low importance', byId(L1.id).source === 'reflection_speculation' && byId(L1.id).importance <= 0.1);
  ok('L3 now reflection_speculation', byId(L3.id).source === 'reflection_speculation');
  ok('grounded G untouched (still reflection_knowledge)', byId(G.id).source === 'reflection_knowledge');
  ok('no-URL real fact N untouched', byId(N.id).source === 'reflection_knowledge');
  ok('real-topic T untouched', byId(T.id).source === 'reflection_knowledge');
  ok('manual U untouched', byId(U.id).source === 'manual');

  console.log('\nrecall excludes the quarantined facts:');
  const r1 = await memory.retrieve('Coast Guard AI Salesforce integration', { k: 5 });
  ok('demoted obsession fact does NOT surface in recall', !r1.some(x => x.id === L1.id));
  const r2 = await memory.retrieve('DuckDuckGo result title selector', { k: 5 });
  ok('grounded fact still recalled', r2.some(x => x.id === G.id));
  ok('idempotent: re-scan finds 0 laundered left', mig.scan().laundered.length === 0);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { require('fs').rmSync(path.dirname(process.env.SQ_DB_PATH), { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
