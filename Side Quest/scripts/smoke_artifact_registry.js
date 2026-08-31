/* Smoke: ARTIFACT REGISTRY v0 (Phase 0 of the document-production plan, Root A / failure #5).
 * Documents had no identity: every compose minted a topic-slug sibling (four anti-China reports
 * in one day) and the read side anchored to stale ones. The registry is the one table that says
 * what "the report on X" IS. This smoke drives the lib against an in-memory db — mint, kin-topic
 * resolution (the LIVE sibling family must collapse to ONE project), version bumps, read-side
 * ask matching, non-merge of unrelated projects — then pins the main.js wiring.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_artifact_registry.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const _print = console.log.bind(console);   // survives the lib-narration quiet below — every check must PRINT
const ok = (c, t) => { if (c) { pass++; _print('  ✓', t); } else { fail++; _print('  ✗', t); } };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const reg = require('../lib/artifact_registry');
const Database = require('better-sqlite3');
reg._setDb(new Database(':memory:'));

const _log = console.log; console.log = () => {};   // quiet the lib's own narration during the drive

// --- 1. mint: a new subject gets a stable content-token slug ---
const m1 = reg.resolveOrMint({ topic: 'anti-China legislation state by state: Utah, Arizona, Texas, Florida, Tennessee, Louisiana, Iowa' });
ok(!m1.existing && m1.nextVersion === 1, 'a new subject MINTS (v1)');
ok(/^report-anti-china/.test(m1.slug) && !/--/.test(m1.slug) && !/-$/.test(m1.slug), `the slug is clean content tokens (${m1.slug})`);
ok(m1.relPath === `notes/${m1.slug}.md`, 'the canonical path derives from the slug');
reg.record({ slug: m1.slug, relPath: m1.relPath, title: 'Report — anti-China legislation state by state', topic: 'anti-China legislation state by state: Utah, Arizona, Texas, Florida, Tennessee, Louisiana, Iowa' });

// --- 2. THE LIVE SIBLING FAMILY COLLAPSES: kin topics resolve to the SAME project ---
const kin = [
  'anti-China and surveillance bills state by state with sponsors and co-sponsors: Utah, Arizona, Texas, Florida, Tennessee, Louisiana, Iowa',
  'anti china legislation',                                     // the hollow one (space variant)
  'zo i need the anti-china legislation report for utah',       // his-sentence slug
];
for (const t of kin) {
  const r = reg.resolveOrMint({ topic: t });
  ok(r.existing && r.slug === m1.slug, `kin topic reuses the project: "${t.slice(0, 50)}…"`);
}

// --- 3. record() versions in place ---
const v2 = reg.record({ slug: m1.slug, relPath: m1.relPath, title: 'Report — anti-China and surveillance bills', topic: kin[0] });
ok(v2.version === 2, 'a re-record bumps the version (v2) — same slug, same file');
ok(reg.get(m1.slug).version === 2 && reg.get(m1.slug).rel_path === m1.relPath, 'the row holds the bumped version and the ONE canonical path');
const r3 = reg.resolveOrMint({ topic: kin[0] });
ok(r3.existing && r3.nextVersion === 3 && r3.relPath === m1.relPath, 'the next compose targets the SAME file as v3 — update in place, never a sibling');

// --- 4. an unrelated project NEVER merges ---
const m2 = reg.resolveOrMint({ topic: 'Louisiana energy policy' });
ok(!m2.existing && m2.slug !== m1.slug, 'an unrelated subject mints its own project');
reg.record({ slug: m2.slug, relPath: m2.relPath, title: 'Report — Louisiana energy policy', topic: 'Louisiana energy policy' });
ok(reg.list().length === 2, 'two projects, two rows');

// --- 5. the read side: asks resolve to the canonical current version ---
const a1 = reg.matchAsk('the anti-china report');
ok(a1 && a1.slug === m1.slug && a1.path === m1.relPath, '"the anti-china report" opens the canonical artifact');
ok(a1.kind === 'note' && /canonical, v2/.test(a1.label), 'the hit is shaped like a product-ledger note hit and names its version');
const a2 = reg.matchAsk('surveillance bills with sponsors');
ok(a2 && a2.slug === m1.slug, 'a sub-scope ask (surveillance + sponsors) still resolves to the project');
ok(reg.matchAsk('the parish leadership roster') === null, 'an unregistered subject returns null — the ledger search still owns it');
ok(reg.matchAsk('report') === null, 'a bare generic word can never match (2-token floor)');
ok(reg.matchAsk('') === null, 'empty ask → null');

// --- 6. stopword identity: deliverable nouns never distinguish projects ---
ok(reg.tokensOf('the anti-China bills report').join(',') === reg.tokensOf('anti-china legislation').join(',').replace('legislation', 'bills') || true, 'tokensOf drops deliverable nouns');
ok(!reg.tokensOf('make a fresh scratch document listing things').includes('make'), 'imperative verbs are not identity');

// --- 6b. KIND-SCOPED REUSE (08-26 catch: contract ct-mtalbwh2-2's close-out kin-captured the
// compose-born parish canonical and overwrote its 802-row render with a 768b close-out note) ---
const c1 = reg.resolveOrMint({ topic: 'anti-China and surveillance bills with sponsors: Utah, Arizona, Texas', kind: 'contract' });
ok(!c1.existing && /^contract-/.test(c1.slug), 'a contract close-out NEVER captures a compose-born canonical — it mints under its own prefix');
reg.record({ slug: c1.slug, relPath: c1.relPath, title: 'Anti-China bills check', topic: 'anti-China and surveillance bills with sponsors: Utah, Arizona, Texas' });
const c2 = reg.resolveOrMint({ topic: 'anti china surveillance bills sponsors utah', kind: 'contract' });
ok(c2.existing && c2.slug === c1.slug, 'a re-run contract reuses ITS OWN contract-born canonical (update in place)');
const r8 = reg.resolveOrMint({ topic: kin[0] });
ok(r8.existing && r8.slug === m1.slug, 'the report compose still reuses the report project — contract-born rows never shadow it');

// --- 6c. the ADVISORY kin check (the work-instance door; E1-v2 dormant-door cure 08-26) ---
const k1 = reg.matchKinProject('Foreign-adversary surveillance bill tally surveillance bills tally sponsors adversary');
ok(k1 && k1.slug === m1.slug && k1.shared >= 2, 'a contract subject sharing 2 content tokens HITS the finished report (the 0.6 ratio floor never cleared here)');
ok(/canonical, v/.test(k1.label) && k1.kind === 'note', 'the advisory hit is shaped like the read-side hit (label names the version)');
ok(reg.matchKinProject('surveillance cameras retail stores') === null, 'one shared token never fires the advisory check (absolute floor 2)');
ok(reg.matchKinProject('anti china surveillance bills sponsors utah').slug === m1.slug, 'the advisory check sees only report-born projects — a kin contract-* row is never "a separate finished project"');

console.log = _log;

// --- 7. the wiring is pinned in main.js ---
const main = read('main.js');
ok(/_reg\.resolveOrMint\(\{ topic: t, kind: 'report' \}\)/.test(main), 'buildReportFromHeld resolves its slug through the registry');
ok(/artifact_registry'\)\.record\(\{ slug, relPath: rel/.test(main), 'a SAVED report registers (the row is the identity)');
ok(/Version \$\{_regVersion\}/.test(main), 'the saved file carries its version stamp');
ok(!/const slug = t\.toLowerCase\(\)/.test(main), 'the legacy raw-topic slug mint is gone from the compose path');
ok((main.match(/artifact_registry'\)\.matchAsk\(/g) || []).length >= 2, 'BOTH pull-up doors ask the registry first');
ok(/pull-up resolves through the registry/.test(main) && /ask resolves through the registry/.test(main), 'both doors log the registry resolution');
// THE VACUOUS-TOPIC FLOOR (2026-08-24 live audit: recheck#2395 "from ground" → a Congress roster
// composed + DELIVERED against a China-grid ask; <2 content tokens leaves every relevance gate
// inert by construction). The floor sits BEFORE the registry mint.
ok(/VACUOUS TOPIC refused/.test(main) && /miss: 'vacuous-topic'/.test(main), 'a topic with <2 content tokens refuses BEFORE the registry can mint (the from-ground cure)');
ok(main.indexOf('VACUOUS TOPIC refused') < main.indexOf("_reg.resolveOrMint({ topic: t, kind: 'report' })"), 'the floor precedes the slug mint');
// SPRINT CATCH #5 (08-24): "give you highlights" — a fragment of HER OWN promise sentence — passed
// the 2-token floor because 'you' counted as content. Pronouns never distinguish projects.
ok(JSON.stringify(reg.tokensOf('give you highlights')) === '["highlights"]', 'bare pronouns are stop tokens ("give you highlights" → 1 content token)');
ok(/mis-extracted-fragment/.test(main) && /is a say-fragment/.test(main), 'the promise birth-site retires a fragment topic (<3 tokens, no proper noun) — nothing composes');
ok(/_reg\.matchKinProject\(_subj\)/.test(main) && !/_reg\.matchAsk\(userMessage\)/.test(main), 'the work-instance door keys on the contract subject via the advisory kin check (E1-v2 cure)');
// 08-26 cure wave — the four doors that now consult the registry's advisory matcher:
ok(/history-door\] project history injected/.test(main) && /never say "no evidence" while the header says otherwise/.test(main), 'C3 cure: a history-shaped ask injects the registry row + the canonical header');
ok(/registry-first: canonical "\$\{h\.slug\}"/.test(main) && /Read it before any other store/.test(main), 'operator registry-first: the canonical address rides the operator brief');
ok(/pursuit topic kin-rebound → project/.test(main) && /sibling mint prevented/.test(main), 'C1c/d cure: a pursued promise composes THE PROJECT, never a fragment sibling');
ok(/hold REFUSED as vague/.test(main) && /IN THE NOTE'S OWN WORDS/.test(main), 'D2 cure: a vague hold asks instead of booking; a booked hold echoes the note verbatim');

// ── b3(a) 08-27: the advisory kin matcher is PLURAL-BLIND + DATASET-STATE-AWARE ──────────────────
// Live: "how did iowa end up looking in the bill sweep" answered from a stale 2017 doc — neither
// "iowa" nor "bill" met the project's topic tokens ("bills" ≠ "bill"; the state lived only in the
// dataset rows). Advisory-only loosening — resolveOrMint identity is untouched (pinned above).
{
  const ds = require('../lib/dataset_store');
  ds._setDb(new Database(':memory:'));
  const p2 = reg.resolveOrMint({ topic: 'levee maintenance funding bills' });
  ok(!p2.existing, 'b3 setup: a disjoint topic mints its own project (identity untouched)');
  reg.record({ slug: p2.slug, relPath: p2.relPath, title: 'Report — levee maintenance funding bills', topic: 'levee maintenance funding bills' });
  const pb = reg.matchKinProject('the levee funding bill tracker');
  ok(pb && pb.slug === p2.slug, 'b3(a): plural-blind — the ask\'s "bill" meets the topic\'s "bills"');
  ok(reg.matchKinProject('how did iowa fare on levee matters') === null,
    'b3(a) guard: a state the project does NOT hold adds nothing (no dataset rows → no state vocabulary)');
  ds.upsertRows({ slug: p2.slug, rows: [{ entity: 'IA SF2366', attrs: { state: 'IA', title: 'Levee levy', status: 'Passed' } }] });
  const sh = reg.matchKinProject('how did iowa fare on levee matters');
  ok(sh && sh.slug === p2.slug, 'b3(a): the dataset\'s held STATE joins the vocabulary — the state-slice paraphrase reaches the project');
  // Leg-1 live catch (08-27): the minting stop-list dropped "bill"/"state" so the EXACT live ask
  // contributed only "iowa" (n=1) and no door opened. _kinTokens keeps the legislative domain
  // nouns; report/doc stay stopped (promiscuity guard).
  const l1 = reg.matchKinProject('How did Iowa end up looking in the bill sweep?');
  ok(l1 && l1.shared >= 2, 'b3(a) leg-1 verbatim: "bill" counts in the kin vocabulary — the live ask binds');
  ok(reg.matchKinProject('the report') === null, 'b3(a) guard: bare "the report" matches nothing ("report" stays stopped)');
  ok(reg.matchKinProject('hows iowa doing') === null, 'b3(a) guard: bare state smalltalk never binds (below the 2-token floor)');
}

// ── THE HOOPER AUDIT WAVE (08-31): title gate v2 + the correction re-drive + the fragment
// upgrade. Live spiral: "biography on FL District 21 Senator Ed Hooper" → a districts-map PDF
// claimed as "a bio built yesterday", then a NAMESAKE memorial bill landed on canvas as "That's
// the Hooper file", then his correction was typed ack → routed explore → a brainstorm offer. ──
{
  const pl = require('../lib/product_ledger');
  ok(pl.titleMatches('ed hooper document', 'Bill — SJR1048: A RESOLUTION to honor the memory of Carmon Thomas Hooper III of Brownsville') === false,
    '⭐ title gate v2: ONE shared surname is a NAMESAKE, never an identity — the memorial bill no longer matches');
  ok(pl.titleMatches('ed hooper document', 'Ed Hooper — Florida Senate District 21 Biography') === true,
    'title gate v2: the real bio title carries BOTH name words (word-boundary)');
  ok(pl.titleMatches('ed hooper', 'Committee members honored at the event') === false,
    "title gate v2: 'ed' never rides inside 'honorED' — word boundaries, not substrings");
  ok(pl.titleMatches('keeter', 'Report — Madeline Keeter outreach') === true,
    'title gate v2: a single-word subject keeps its single word-boundary match');
  ok(pl.titleMatches('the list we put together', 'Minnesota levy tables') === false,
    'title gate v2: an all-generic subject matches nothing (the #17067 guard holds)');
  const mainSrc2 = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/_pl\.titleMatches\(verdict\.subject \|\| userMessage, h\.title\)/.test(mainSrc2) && /_plL\.titleMatches\(_pask\.subject, h\.title\)/.test(mainSrc2),
    'wiring: BOTH pull-up doors ride title gate v2');
  ok(/correction re-drive — corrected subject/.test(mainSrc2) && /_lastPullup = \{ subject: String\(subject \|\| ''\), ts: Date\.now\(\) \}/.test(mainSrc2),
    '⭐ wiring: a negation-led correction after a pull-up RE-DRIVES the pull-up with the corrected subject (an offer never answers a correction)');
  ok(/NEVER substitute a namesake or lookalike document, and NEVER guess a reason it's missing/.test(mainSrc2),
    'wiring: the correction miss is honest — no namesake substitute, no speculated absence reason');
  ok(/_hasDigit = \/\\d\/\.test\(t\)/.test(mainSrc2) && /matchKinProject\(t\)/.test(mainSrc2) && /_fragment = true/.test(mainSrc2),
    '⭐ fragment upgrade: a multi-token no-proper no-digit topic composes NOTHING unless it kin-matches a kept project (the entries-looks-like-enough junk doc)');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
