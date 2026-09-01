/**
 * THE DONE CONTRACT (2026-08-14, Lucas-approved): done is a contract signed at intake, not a model
 * judgment. Pins: freeze-once (the plan cannot regrow), the entity anchor line (and the
 * topic-as-written fallback — the #3869 GOV.UK drift cure), write-once outline, the dryness math
 * (3 identical gather signatures = two no-add passes), and the once-only auto-finalize valve.
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\smoke_doc_contract.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_dcon_${Date.now()}.db`);
require('../lib/db').init();
const dc = require('../lib/doc_contract');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

// Freeze-once: a second freeze with a BROADER topic returns the original contract untouched.
const c1 = dc.freeze({ threadId: 9001, topic: 'applied digital', entity: { name: 'Applied Digital Corp (APLD)', evidence: 'US data-center company, Ellendale ND' } });
ok('first freeze takes', c1.justFrozen === true && c1.topic === 'applied digital');
const c2 = dc.freeze({ threadId: 9001, topic: 'applied digital AND all adjacent industries' });
ok('re-freeze with a broader topic is REFUSED (the plan cannot regrow)', c2.justFrozen === false && c2.topic === 'applied digital');

// The anchor line, both tiers.
ok('entity anchor names the resolved entity and forbids look-alikes', (() => {
  const l = dc.anchorLine(dc.get(9001));
  return l.includes('Applied Digital Corp (APLD)') && /OFF-TARGET/.test(l) && /do not rationalize/i.test(l);
})());
dc.freeze({ threadId: 9002, topic: 'data center community benefits' });
ok('no-entity fallback still pins the topic AS WRITTEN (concept-drift cure)', (() => {
  const l = dc.anchorLine(dc.get(9002));
  return l.includes('"data center community benefits"') && /never reinterpret/i.test(l) && /OFF-TARGET/.test(l);
})());

// Outline write-once.
ok('outline locks at first set', JSON.stringify(dc.setOutline(9001, ['A', 'B', 'C'])) === '["A","B","C"]');
ok('a later, larger outline is REFUSED (scope never grows)', JSON.stringify(dc.setOutline(9001, ['A', 'B', 'C', 'D', 'E'])) === '["A","B","C"]');

// Gather signature: order-independent, size-sensitive; accepts both row shapes.
const s1 = dc.gatherSignature([{ file: 'a.md', text: 'xxxx' }, { file: 'b.md', text: 'yy' }]);
const s2 = dc.gatherSignature([{ file: 'b.md', len: 2 }, { file: 'a.md', len: 4 }]);
ok('signature is order-independent across row shapes', s1 === s2 && s1.length === 16);
ok('new material changes the signature', dc.gatherSignature([{ file: 'a.md', len: 5 }, { file: 'b.md', len: 2 }]) !== s1);
ok('an empty gather signs empty (never counts as dry)', dc.gatherSignature([]) === '');

// Dryness: two consecutive no-add passes = last 3 recorded signatures identical.
dc.recordGatherSig(9001, 'sig-A');
dc.recordGatherSig(9001, 'sig-B');   // material grew
dc.recordGatherSig(9001, 'sig-B');   // pass added nothing (1st)
ok('one no-add pass is NOT dry yet', dc.isDry(9001) === false);
dc.recordGatherSig(9001, 'sig-B');   // pass added nothing (2nd)
ok('two consecutive no-add passes = DRY', dc.isDry(9001) === true);
dc.freeze({ threadId: 9003, topic: 'empty topic' });
dc.recordGatherSig(9003, ''); dc.recordGatherSig(9003, ''); dc.recordGatherSig(9003, '');
ok('an empty gather never reads dry (nothing to finalize)', dc.isDry(9003) === false);

// The once-only valve: dry + unfinalized fires; after markFinalized it NEVER fires again.
ok('dry + unfinalized → auto-finalize fires', dc.shouldAutoFinalize(9001) === true);
dc.markFinalized(9001, 'sig-B');
dc.recordGatherSig(9001, 'sig-B');
ok('after finalize the valve is CLOSED — revisions are Lucas\'s ask', dc.shouldAutoFinalize(9001) === false && dc.isDry(9001) === true);

// entityAnchorFrom — THE FIRST LIVE MISFIRE (#3882, minutes after deploy): "search sponsor"
// semantically matched "Hunt (WA)" (a BILL sponsor) and the raw JSON blob became the "name".
const LIVE_MISFIRE = '[{"id":1377599,"name":"Hunt (WA)","entity_type":"person","entity_subtype":"legislator","summary":"Sponsor in WA 2017-2018","confidence":0.85}]';
ok('the live misfire anchors NOTHING (no shared token between name and topic)', dc.entityAnchorFrom('search sponsor', LIVE_MISFIRE) === null);
ok('a real resolution anchors (name parsed from the JSON shape, not the blob)', (() => {
  const a = dc.entityAnchorFrom('applied digital', '[{"name":"Applied Digital Corp (APLD)","summary":"US data-center company, Ellendale ND"}]');
  return a && a.name === 'Applied Digital Corp (APLD)' && a.evidence.includes('data-center') && !a.name.startsWith('[');
})());
ok('a plain-text resolution line still anchors when it names the topic', (() => {
  const a = dc.entityAnchorFrom('applied digital', 'Applied Digital Corporation — data centers in Ellendale');
  return a && /Applied Digital Corporation/.test(a.name);
})());
ok('unparseable / empty resolutions anchor nothing', dc.entityAnchorFrom('applied digital', '') === null && dc.entityAnchorFrom('', 'Applied Digital') === null);

// ⭐ THE SECOND MISFIRE CLASS (#4162/#4163 boot_p216): one shared GENERIC token bound namesakes.
// The suiteFor law verbatim: a single generic token never binds; one SPECIFIC token or two do.
const CUF_TOPIC = 'investigate what are center urban future cuf major funding sources total revenue any funder relationships create potential bias its affordability agenda';
ok('⭐ the live #4163 misfire anchors NOTHING ("urban" alone is generic — an FEC committee is not CUF)',
  dc.entityAnchorFrom(CUF_TOPIC, '[{"name":"URBAN DEVELOPMENT FUND [C00727420]","summary":"FEC committee"}]') === null);
ok('⭐ the live #4162 misfire anchors NOTHING ("housing" alone is generic — a CO task force is not CUF)',
  dc.entityAnchorFrom('investigate how does center urban future cuf frame causal relationship between housing affordability economic mobility',
    '[{"name":"Affordable Housing Transformational Task Force (CO)","summary":"Colorado legislative task force"}]') === null);
ok('the TRUE entity still binds (3 shared tokens: center + urban + future)', (() => {
  const a = dc.entityAnchorFrom(CUF_TOPIC, '[{"name":"Center for an Urban Future","summary":"NYC think tank, economic mobility research"}]');
  return a && a.name === 'Center for an Urban Future';
})());
ok('one SPECIFIC shared token still binds (mercatus is nobody\'s generic)', (() => {
  const a = dc.entityAnchorFrom('profile mercatus funding sources', '[{"name":"Mercatus Center at George Mason University","summary":"free-market think tank"}]');
  return a && /Mercatus/.test(a.name);
})());

// The repair door: clear → a fresh freeze takes (a wrong anchor is never pinned forever).
dc.clear(9001);
const c3 = dc.freeze({ threadId: 9001, topic: 'applied digital corp' });
ok('clear() reopens the contract — a wrong freeze is repairable', c3.justFrozen === true && c3.topic === 'applied digital corp');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
try { require('../lib/db').getDb().close(); } catch {}
try { fs.unlinkSync(process.env.SQ_DB_PATH); } catch {}
process.exit(fail === 0 ? 0 : 1);
