/* smoke_tier_law.js — THE TRIGGER-TO-TIER LAW (stage 4.5 item 2, 2026-09-04): one table both runtimes read,
 * served at GET /tiers; his master-skill dispatcher (P5) folded in as data. Pure.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_tier_law.js
 */
'use strict';
const fs = require('fs'), path = require('path');
const tl = require('../lib/tier_law');
const q = require('../lib/quota');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// the tiers are the usage law's tiers, exactly
ok(JSON.stringify(tl.TIERS) === JSON.stringify(Object.keys(q.TIER)), `the table's tiers ARE lib/quota's tiers, in order (${tl.TIERS.join(', ')})`);
ok(tl.EXPANSION.every((t) => q.EXPANSION_TIERS.has(t)) && tl.EXPANSION.length === q.EXPANSION_TIERS.size, 'the expansion pair matches the pace gate\'s EXPANSION_TIERS');
ok(Object.values(tl.TRIGGER_TIERS).every((t) => tl.TIERS.includes(t)), 'every trigger maps to one of the six tiers (interactive, directed, presence, development, research, idle)');
// the law's sentence, row by row
ok(tl.tierForTrigger('chat') === 'directed' && tl.tierForTrigger('directed') === 'directed' && tl.tierForTrigger('manual') === 'directed', '⭐ chat, directed and manual bill DIRECTED — a chat-triggered delegate is never paced as research again');
ok(tl.tierForTrigger('cron') === 'research' && tl.tierForTrigger('cadence') === 'research' && tl.tierForTrigger('scheduled') === 'research' && tl.tierForTrigger('beat') === 'research', 'scheduled kinds bill EXPANSION (research)');
ok(tl.tierForTrigger('pen') === 'development' && tl.tierForTrigger('rehearsal') === 'development' && tl.tierForTrigger('pursuit') === 'development', 'the pen, the rehearsal and the pursuit bill DEVELOPMENT');
ok(tl.tierForTrigger('subc') === 'idle' && tl.tierForTrigger('wonder') === 'idle' && tl.tierForTrigger('puller') === 'idle', 'the drift lanes bill idle (expansion)');
ok(tl.tierForTrigger('consciousness') === 'presence' && tl.tierForTrigger('autonomy') === 'presence' && !tl.isExpansionTier('presence') && q.tierOf('consciousness') === 'presence', 'the consciousness loop and the autonomy decider bill presence — never expansion, never paced (09-05)');
ok(tl.tierForTrigger('INTERACTIVE') === 'interactive' && tl.tierForTrigger(' Chat ') === 'directed', 'kinds are case- and space-insensitive');
ok(tl.tierForTrigger('never-heard-of') === 'research' && tl.tierForTrigger('') === 'research' && tl.tierForTrigger(null) === 'research', 'an unknown kind falls to research — the paced, conservative side');
ok(tl.isExpansionTier('research') && tl.isExpansionTier('idle') && !tl.isExpansionTier('directed') && !tl.isExpansionTier('development'), 'isExpansionTier names the paced pair');
// the read door serves the table
const t = tl.table();
ok(t.version === 1 && Array.isArray(t.tiers) && t.triggers.chat === 'directed' && t.default === 'research' && t.rules.length === 7, 'table() carries version, tiers, triggers, the default, the seven rules and the confidence thresholds');
ok(/req\.url\.startsWith\('\/tiers'\)/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'test_port.js'), 'utf8')) && /require\('\.\/tier_law'\)\.table\(\)/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'test_port.js'), 'utf8')), '⭐ the control port serves GET /tiers from this table (the door Echo\'s governor reads)');
// P5 rides in as data, verbatim
ok(tl.SEVEN_RULES.length === 7 && /^No-ask/.test(tl.SEVEN_RULES[0]) && /^Quality gates/.test(tl.SEVEN_RULES[6]), 'his seven core rules, in order');
ok(tl.INTENT_ROUTES.length === 48 && tl.INTENT_ROUTES.every((r) => r.keywords.length && r.lead && Array.isArray(r.chain)), 'his domain routing table: 48 rows, each with keywords, a lead skill and an auto-chain');
ok(JSON.stringify(tl.routeIntent('please research topic X and benchmark the tools')) === JSON.stringify({ lead: 'research-skill', chain: ['research-deep', 'research-report'], matched: 'research topic' }), 'routeIntent: "research topic" → research-skill → research-deep → research-report');
ok(tl.routeIntent('we need an NDA reviewed').lead === 'legal:nda-triage' && tl.routeIntent('build me a deck').lead === 'pptx', 'routeIntent: NDA → nda-triage; deck → pptx');
ok(tl.routeIntent('nothing routable here at all') === null && tl.routeIntent('') === null, 'no keyword → null (the chat stays the lobby)');
ok(tl.routeIntent('the gl close is late').lead === 'finance:journal-entry' && tl.routeIntent('a global view of the gland') === null, 'short keywords match at word boundaries only ("gl" never matches "global")');
ok(Object.keys(tl.CHAINS).length === 6 && tl.CHAINS.research[0] === 'research-skill' && tl.CHAINS.legal[0] === 'legal:nda-triage', 'the six standard chain protocols');
ok(tl.ENVELOPE.payload && Array.isArray(tl.ENVELOPE.sources) && tl.ENVELOPE._next === 'skill-name | null' && tl.ENVELOPE_RULES.length === 3, 'the universal JSON envelope and its three rules');
ok(tl.confidenceLabel(0.95) === 'verified' && tl.confidenceLabel(0.8) === 'likely' && tl.confidenceLabel(0.5) === 'uncertain' && tl.confidenceLabel('x') === 'uncertain', 'confidence: 0.9+ verified · 0.7–0.9 likely · <0.7 uncertain');
ok(tl.EXECUTION_DEFAULTS.research_items === 10 && tl.EXECUTION_DEFAULTS.content_length_words === 1200 && tl.EXECUTION_DEFAULTS.final_report_format === '.docx', 'his execution defaults');
ok(Object.isFrozen(tl.TRIGGER_TIERS) && Object.isFrozen(tl.INTENT_ROUTES) && Object.isFrozen(tl.SEVEN_RULES), 'the tables are frozen — a consumer cannot mutate the law');
// the Echo side carries a local copy of the shared kinds, pinned equal by its own test; here the same kinds resolve identically
for (const [k, lane] of Object.entries({ chat: 'directed', manual: 'directed', cron: 'research', event: 'research', cadence: 'research', pen: 'development', rehearsal: 'development', pursuit: 'development', idle: 'idle', subc: 'idle' })) {
  ok(tl.tierForTrigger(k) === lane, `shared kind ${k} → ${lane} (Echo's local copy says the same; its test pins the two equal)`);
}

console.log(`\nsmoke_tier_law: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
