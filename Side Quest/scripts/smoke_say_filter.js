/* smoke_say_filter.js — the one-voice filter: steering vocab (F5b) and tool-call JSON (F23)
 * never reach a user-facing say; the F23 leak never pollutes a booked promise topic.
 *
 * Live evidence (run-2 / run-2b, docs/LIVE_TEST_RUN2_2026-08-19.md):
 *  - F5b: "facet corrected to …", "depth is now deep, two-lane research", agent run-ID UUIDs, and a
 *    "Need: …" planning fragment surfaced verbatim in says.
 *  - F23: the operator's raw JSON tool-call rode into a say as visible text while the tool also
 *    executed — and the leaked JSON then polluted the booked promise topic (deliverySubjectFrom).
 */
'use strict';
const sf = require('../lib/say_filter');
const dlv = require('../lib/delivery');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

// ── F5b: steering vocabulary goes ───────────────────────────────────────────────────────────────
{
  const s = sf.stripSteeringVocab('Good catch. facet corrected to Louisiana Senate District 14. I will keep digging.');
  ok(!/facet corrected/i.test(s), 'facet-correction steering line is stripped');
  ok(/Good catch\./.test(s) && /keep digging/.test(s), '…and the surrounding voice survives');

  const d = sf.stripSteeringVocab('Understood — depth is now deep, two-lane research. Starting with the filings.');
  ok(!/depth is now/i.test(d), 'depth-steering line is stripped');
  ok(/Starting with the filings/.test(d), '…without eating the real sentence');

  const u = sf.stripSteeringVocab('The run finished (b241b4aa-1c2d-4e5f-8a9b-0c1d2e3f4a5b) and the brief is solid.');
  ok(!/b241b4aa/.test(u), 'a bare run-ID UUID is stripped');
  ok(/the brief is solid/.test(u), '…prose intact');

  const n = sf.stripSteeringVocab('Here is where I stand.\nNeed: private agent data before compose\nThe sheet is next.');
  ok(!/Need:/.test(n), 'a leaked "Need:" planning fragment is stripped');
  ok(/The sheet is next\./.test(n), '…following line intact');

  ok(sf.stripSteeringVocab('I need a coffee. What do you need from me?') === 'I need a coffee. What do you need from me?',
    'ordinary "need" prose is never touched');
}

// ── F23: tool-call JSON goes ────────────────────────────────────────────────────────────────────
{
  const leak = 'Pulling the AFIDA numbers now. {"tool": "web_search", "args": {"query": "AFIDA 2023 annual report acreage"}} This will take a moment.';
  const s = sf.stripToolJson(leak);
  ok(!/web_search/.test(s), 'a {"tool": …} call block is stripped');
  ok(/Pulling the AFIDA numbers now\./.test(s) && /take a moment/.test(s), '…voice on both sides survives');

  const named = 'On it. {"name": "legiscan_search", "arguments": {"query": "SB200", "state": "LA"}}';
  ok(!/legiscan_search/.test(sf.stripToolJson(named)), 'a {"name" + "arguments"} call block is stripped');

  const prose = 'In JSON you write {"count": 3} to store a number.';
  ok(sf.stripToolJson(prose) === prose, 'an ordinary JSON snippet in prose is NOT a tool call — untouched');

  const unbalanced = 'The brace { just sits here in prose.';
  ok(sf.stripToolJson(unbalanced) === unbalanced, 'an unbalanced brace is left alone');

  const nested = 'Done. {"tool":"db_query","args":{"sql":"select 1","opts":{"limit":5}}} — results follow.';
  ok(!/db_query/.test(sf.stripToolJson(nested)), 'nested args (two levels) still strip');
}

// ── the composite keeps everything honest at once ───────────────────────────────────────────────
{
  const messy = '*nods* The bills are *stalling*, fast. {"tool":"web_search","args":{"q":"x"}} facet corrected to Indiana.';
  const s = sf.filterSay(messy);
  ok(!/nods/.test(s), 'composite: gesture removed');
  ok(/stalling/.test(s) && !/\*stalling\*/.test(s), 'composite: emphasis word kept, markup dropped');
  ok(!/web_search/.test(s), 'composite: tool JSON removed');
  ok(!/facet corrected/i.test(s), 'composite: steering removed');
  ok(/The bills are stalling, fast\./.test(s), 'composite: the real sentence survives intact');
}

// ── F23 → C1 seam: a leaked tool call never pollutes the booked topic ───────────────────────────
{
  const say = 'I\'ll compile the verification note on the AFIDA acreage numbers {"tool":"web_search","args":{"query":"AFIDA"}} and land it.';
  const subj = dlv.deliverySubjectFrom(say, 'note');
  ok(!/tool|query|web_search/i.test(subj), `booked topic carries no JSON keys (got: "${subj}")`);
  ok(/AFIDA/i.test(subj), `booked topic still names the real subject (got: "${subj}")`);
}

// ── R5: the "let me get that going" deflection filler never reaches the say (banned every path) ──
{
  const a = sf.filterSay('Folding the teacher bonuses into the Good Neighbor work. On it — let me get that going.\n\nOne thing worth pulling on: the LCTCS angle.');
  ok(!/let me get that going/i.test(a), 'R5: the deflection filler is stripped from the say');
  ok(/On it\./.test(a) && !/—\s*$/m.test(a) && /LCTCS/.test(a), 'R5: the real ack keeps its period + substance survives, no dangling connector ("On it.")');
  ok(sf.filterSay('let me get this going').trim() === '', 'R5: a bare deflection phrase strips to empty (the model was told never to send it alone)');
  ok(/Pulling the AFIDA numbers now\./.test(sf.filterSay('Pulling the AFIDA numbers now.')), 'R5: a concrete starting ack is untouched');
}

// ── say-splice (main.js wiring): the paper announce quotes a bounded title + conditions the cite claim ──
{
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/SAY-TRUTH \(say-splice/.test(src) && /the finished paper on "\$\{_paperTitle\}"/.test(src),
    '⭐ say-splice: the announce quotes a bounded title (a raw order fragment can no longer garble the grammar)');
  ok(/r\.sourceCount > 0[\s\S]{0,140}every inline citation resolving[\s\S]{0,120}synthesized from held material/.test(src),
    '⭐ say-splice: the "citations resolving" claim is conditioned on sourceCount>0 (0 sources says so plainly, no contradiction)');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
