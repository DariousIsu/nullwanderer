/* smoke_package.js — the local model's output is a ROADMAP, and it is bounded and measured.
 *
 * The cloud gets a fresh context every call, so whatever is not in the package does not exist for
 * that turn. Two failure modes, both silent: an overflowing package drops its tail, an underfilled
 * one pays frontier prices for a window it never uses. Every assertion here exists because one of
 * those would otherwise pass unnoticed — which is exactly how num_ctx sat at 8192 for months.
 *
 * Pure module, no I/O — nothing is stubbed because nothing is fetched.
 */
'use strict';
const P = require('../lib/package');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

const rep = (r, name) => r.report.sections.find((s) => s.name === name);

// ── the budget follows the WINDOW, and reserves room for the reply ──────────────────────────────
{
  const small = P.inputBudgetChars({ num_ctx: 8192, num_predict: 2048 });
  const big = P.inputBudgetChars({ num_ctx: 131072, num_predict: 2048 });
  ok(big > small * 10, 'a 131k window buys an order of magnitude more package than 8k');
  ok(small < 8192 * P.CHARS_PER_TOKEN, 'the reply budget is reserved, not spent on input');
  ok(P.inputBudgetChars({ num_ctx: 1000, num_predict: 900 }) >= 2000, 'a floor keeps a tiny window usable');
}

// ── ⭐ SURVIVAL ORDER: who she is and what was asked outrank retrieved text ──────────────────────
{
  const big = 'g'.repeat(200000);
  const r = P.build({
    budgetChars: 4000,
    sections: {
      identity: 'You are Zoe.', request: 'What are the laws of thermodynamics?',
      plan: 'HOW TO WORK THIS TURN: …', manifest: 'm'.repeat(5000),
      tools: 't'.repeat(5000), memory: 'm'.repeat(5000), grounding: big,
    },
  });
  const c = r.messages[0].content;
  ok(c.includes('You are Zoe.'), 'identity survives a hard squeeze');
  ok(c.includes('What are the laws of thermodynamics?'), 'the REQUEST survives — it is never the thing dropped');
  ok(c.includes('HOW TO WORK THIS TURN'), 'the plan survives');
  ok(rep(r, 'grounding').trimmed, 'grounding is trimmed first');
  ok(rep(r, 'grounding').chars < 200000, 'grounding actually shrank');
  for (const n of ['identity', 'request', 'plan']) ok(!rep(r, n).trimmed, `${n} is never trimmed`);
}

// ── an untrimmable section that is ITSELF huge must not silently starve the rest ─────────────────
{
  const r = P.build({ budgetChars: 3000, sections: { identity: 'i'.repeat(9000), grounding: 'g'.repeat(9000) } });
  ok(rep(r, 'identity').chars === 9000, 'a huge identity is still delivered whole');
  ok(rep(r, 'grounding').chars === 0 || rep(r, 'grounding').trimmed, 'the weighted sections absorb the overrun');
  ok(r.report.fit > 1, 'REPORTED as over budget rather than hidden — the operator can see it');
}

// ── ⭐ THE MANIFEST CARRIES COUNTS AND KEYS, NEVER ROWS ──────────────────────────────────────────
{
  const m = P.buildManifest([
    { key: 'puller.targets', label: 'people/orgs', count: 238475, how: '<echo-recipe name="find-person" arg="NAME"/>' },
    { key: 'doc_contacts', label: 'contacts with an email', count: 42, how: 'contacts query, state=LA' },
    { key: 'news.stories', label: 'tracked stories', count: null, how: '<echo-find>news on X</echo-find>' },
    { key: 'empty.store', label: 'nothing', count: 0, how: 'n/a' },
  ]);
  ok(/238,475/.test(m), 'counts are rendered readably');
  ok(/find-person/.test(m), 'the HOW is included — a count with no key is not actionable');
  ok(/news\.stories/.test(m) && /some/.test(m), 'an unknown count still lists the store (else it can never be asked for)');
  ok(!/empty\.store/.test(m), 'an EMPTY store is omitted — it would only buy a wasted hop');
  ok(m.length < 800, 'the manifest is tens of tokens, not thousands — the whole point');
  ok(P.buildManifest([]) === '', 'no stores → no block');
}

// ── ⭐ THE PLAN: hard commands, back-check, depth ────────────────────────────────────────────────
{
  const p = P.buildPlan({ intent: 'a physics question plus a claim about chip design', depth: { maxHops: 3 }, mustCite: true, unresolved: ['which fab process'] });
  ok(/up to 3 tool call/.test(p), 'the DEPTH budget is stated, not left to guess');
  ok(/BACK-CHECK/.test(p), 'a back-check step is commanded');
  ok(/didn't look|didn’t look/.test(p), 'the honesty rule is explicit: not-having differs from not-looking');
  ok(/Cite the source/.test(p), 'mustCite adds the citation command');
  ok(/which fab process/.test(p), 'known gaps are handed over rather than rediscovered');
  ok(/Answer the question that was asked/.test(p), 'answering the actual question is a hard command');
  ok(/database first/i.test(p), 'our own DB is ordered before the open web — the token-spend lever');
  const bare = P.buildPlan({});
  ok(/up to 3 tool call/.test(bare), 'a sane default depth with no args');
  ok(!/Cite the source/.test(bare), 'citation command only when asked for');
}

// ── the report makes BOTH failure modes visible ──────────────────────────────────────────────────
{
  const under = P.build({ budgetChars: 100000, sections: { identity: 'short', request: 'hi' } });
  ok(under.report.fit < 0.05, 'an underfilled package is reported — we are paying for unused window');
  ok(under.report.trimmedAny === false, 'nothing trimmed → flagged false');
  const over = P.build({ budgetChars: 500, sections: { identity: 'i', grounding: 'g'.repeat(50000) } });
  ok(over.report.trimmedAny === true, 'a trim is always flagged');
  ok(rep(over, 'grounding').raw === 50000, 'the ORIGINAL size is retained so the loss is quantifiable');
  ok(/fit \d+%/.test(P.describe(over.report)), 'describe() gives a one-line per-turn log');
}

// ── trimming never cuts mid-word ─────────────────────────────────────────────────────────────────
{
  const t = P._trim('alpha beta gamma delta epsilon zeta eta theta', 20);
  ok(!/\balph$|\bbet$|\bgamm$/.test(t.split(' […')[0]), 'no mid-word cut');
  ok(/trimmed/.test(t), 'the trim is announced in-band so the model knows it is not the whole picture');
  const para = P._trim('para one text here\n\npara two text here\n\npara three', 30);
  ok(/para one/.test(para), 'prefers a paragraph boundary');
  ok(P._trim('short', 100) === 'short', 'under budget → untouched, no marker');
}

// ── section order is stable and complete ─────────────────────────────────────────────────────────
{
  ok(P.ORDER.join(',') === 'identity,request,plan,manifest,tools,memory,grounding', 'survival order is pinned');
  ok([...P.UNTRIMMABLE].every((n) => P.ORDER.includes(n)), 'every untrimmable section is in the order');
  const wsum = Object.values(P.WEIGHTS).reduce((a, b) => a + b, 0);
  ok(wsum < 1, 'weights leave headroom for the tool results the cloud will pull');
}

// ── WIRING: the packager is actually in front of the cloud call ─────────────────────────────────
// Built-but-not-connected is this codebase's signature failure, so assert the seam itself.
{
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/const pkg = require\('\.\/lib\/package'\)/.test(src), 'main.js builds the package for the cloud turn');
  ok(/pkg\.buildManifest\(inv\)/.test(src), 'the manifest is built from the live DB inventory');
  ok(/pkg\.buildPlan\(\{/.test(src), 'the plan/roadmap is built');
  ok(/sections: \{ identity: messages\.map/.test(src),
    "today's tuned prompt rides the UNTRIMMABLE slot — the packager can only ADD, never silently drop it");
  ok(/window: await require\('\.\/lib\/cloud_window'\)\.resolve/.test(src),
    'the package is budgeted against the REAL model window, not a guess');
  ok(/\[package\] \$\{pkg\.describe/.test(src), 'package size is logged per turn — observable, not inferred');
  ok(/cloudMessages = built\.messages/.test(src), 'the built package is what actually gets sent');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
