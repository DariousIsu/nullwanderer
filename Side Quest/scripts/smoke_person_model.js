/* Smoke: lib/person_model + lib/ask_door — CONVERSATIONAL AWARENESS (cut 3; the law: "she shows no curiosity at all").
 * An in-memory database; no model, no network. Pins the seed minus known facts, the gap ordering, the door's cadence,
 * the offer/learning classing on real samples from the law's measurement, carried questions not re-asked, an answer
 * closing a gap, and the invariant: no write path to the fact graph.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_person_model.js
 */
'use strict';
const path = require('path'), fs = require('fs');
const ROOT = path.join(__dirname, '..');
const Database = require('better-sqlite3');
const PM = require(path.join(ROOT, 'lib', 'person_model'));
const AD = require(path.join(ROOT, 'lib', 'ask_door'));
let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
PM._setDb(new Database(':memory:'));
const T0 = 1_800_000_000_000;

// the seed: the partner-grade gaps minus what the store already holds
const me = PM.seedOwner({ knownFacts: ['Lucas has two dogs, Rawr and Lucifer', 'his son Jay is 16', "Lucas's office is on the back patio"], now: T0 });
ok(me && me.kind === 'owner' && me.unknowns.length === PM.OWNER_GAPS.length, `his row holds ${me.unknowns.length} partner-grade gaps`);
ok(me.unknowns.find((u) => u.id === 'family').learned === true && me.unknowns.find((u) => u.id === 'his_day').learned === false, 'a stored fact about his son closes the family gap at the seed; his day stays open');
const top = PM.topGap('owner');
ok(top && top.id === 'his_day' && /how his day went/.test(top.question), `the top gap is the heaviest open one (${top && top.id})`);
ok(PM.openGaps('owner', { limit: 3 }).map((g) => g.id).join(',') === 'his_day,worry,last_deliverable', 'gaps come heaviest first');

// the door's cadence and the prompt block
const d1 = AD.decide({ socialTurn: true, gap: top, turnsSinceLastAsk: Infinity, social: 0.7 });
ok(d1.ask && d1.gap.id === 'his_day' && /never asked/.test(d1.why), 'on a personal turn with an open gap and nothing asked yet, the door opens');
ok(!AD.decide({ socialTurn: false, gap: top, turnsSinceLastAsk: Infinity, social: 0.7 }).ask, 'a work turn keeps the door shut');
ok(!AD.decide({ socialTurn: true, gap: top, turnsSinceLastAsk: 3, social: 0.7 }).ask && AD.decide({ socialTurn: true, gap: top, turnsSinceLastAsk: 6, social: 0.7 }).ask, 'at most one learning question per six turns');
ok(!AD.decide({ socialTurn: true, gap: top, turnsSinceLastAsk: Infinity, social: 0.1 }).ask, 'a low social reading keeps it shut');
ok(!AD.decide({ socialTurn: true, gap: top, turnsSinceLastAsk: Infinity, social: 0.7, enabled: false }).ask, 'ZOE_ASK_DOOR=0 shuts it');
const pb = AD.promptBlock(top);
ok(/a real question about it is welcome/.test(pb) && /equally fine not to ask/.test(pb) && !/must|should ask|always ask/.test(pb), 'the prompt says a question is welcome — never that she must ask');

// classing: the law's measured samples — every question she asked was an offer; the one real one was learning
const offers = ['Want me to pull dossiers on the three of them?', 'Want me to draft that diff?', 'Should I dig into the FEC filings tonight?', 'Do you want me to start the Louisiana parishes document?', 'Shall I send it to the printer?', 'Can I run the numbers again for you?', 'Would you like me to keep watching the feed?', 'Need me to book it?', 'Let me know if you want the long version?', 'I could pull the roster — want that?'];
const learning = ["How'd the Florida calls go yesterday?", 'Did Raegan have a good time at Comicon?', 'What are you reading these days?', 'How was the drive back?', 'Is your dad doing better?', 'What has you worried this week?'];
ok(offers.every((q) => AD.classify(q) === 'offer'), 'ten real offers class as offers');
ok(learning.every((q) => AD.classify(q) === 'learning'), 'six real learning questions class as learning');
const dq = AD.detectQuestion('That went about as well as last time. <sigh> How was the drive back?');
ok(dq && dq.kind === 'learning' && /How was the drive back\?/.test(dq.question), 'the trailing question is detected and classed (tags stripped)');
ok(AD.detectQuestion('Done. The parishes document is in your folder.') === null && AD.detectQuestion('It is ready. Want me to send it?').kind === 'offer', 'no question → null; a trailing offer → offer');

// the ledger: asked → carried → not re-asked → answered → closed
const lid = PM.ledgerAdd({ turnId: 100, key: 'owner', gapId: 'his_day', kind: 'learning', question: 'How was your day, really?', now: T0 + 1000 });
PM.markAsked('owner', 'his_day', { now: T0 + 1000 });
ok(PM.get('owner').unknowns.find((u) => u.id === 'his_day').carried === true && PM.ledgerPending('owner').id === lid, 'a learning question is stamped on the gap (carried) and pending in the ledger');
ok(PM.turnsSinceLastAsk('owner', { turnIdNow: 104 }) === 4 && !AD.decide({ socialTurn: true, gap: PM.topGap('owner'), turnsSinceLastAsk: 4, social: 0.7 }).ask, 'four turns later the door stays shut');
ok(PM.topGap('owner').id === 'worry', 'a carried question falls behind the other open gaps');
PM.ledgerAnswer(lid, 105); PM.closeGap('owner', 'his_day', { learned: 'his day: the mower died twice and the AC kept him sane', now: T0 + 5000 });
const after = PM.get('owner');
ok(after.unknowns.find((u) => u.id === 'his_day').learned === true && after.known.some((k) => /mower died/.test(k.text)) && PM.ledgerPending('owner') === null && PM.ledgerCounts().learning.answered === 1, 'his answer closes the gap, becomes something known, and the ledger shows it answered');
ok(PM.ledgerAdd({ turnId: 106, kind: 'offer', question: 'Want me to draft it?' }) > 0 && PM.ledgerCounts().offer.n === 1 && PM.ledgerCounts().learning.n === 1, 'offers are counted apart from learning questions');

// third parties: the standing gap, unless the relation is already known
const rae = PM.mintThirdParty({ key: 'person:raegan', label: 'Raegan', kind: 'contact', now: T0 });
ok(rae && rae.unknowns.length === 1 && rae.unknowns[0].id === 'who_to_him', 'a new name enters with the standing gap "who is this to him"');
const known = PM.mintThirdParty({ key: 'person:jay', label: 'Jay', relation: 'his son', now: T0 });
ok(known.unknowns.length === 0 && known.known.some((k) => /to him: his son/.test(k.text)), 'a known relation enters with no gap');
ok(PM.mintThirdParty({ key: 'person:raegan', label: 'Raegan' }).unknowns.length === 1 && PM.all().length === 3, 'minting is idempotent; three models held');

// facts learned any other way close the gaps they cover
PM.noteFacts('owner', ['Lucas is worried about the Delaware validation running long'], { now: T0 + 9000 });
ok(PM.get('owner').unknowns.find((u) => u.id === 'worry').learned === true && PM.get('owner').known.some((k) => /Delaware/.test(k.text)), 'a captured fact closes the gap it covers and is known');
// third parties from the encounter stream: a read of the graph, never a write
const minted = PM.sweepThirdParties({ now: T0, deps: { rows: [{ key: 'person:clayton', label: 'Clayton', relation: null }, { key: 'person:jay', label: 'Jay', relation: 'his son' }, { key: 'person:mara', label: 'Mara', relation: 'his sister' }] } });
ok(minted.join(',') === 'person:clayton,person:mara' && PM.get('person:clayton').unknowns.length === 1 && PM.get('person:mara').unknowns.length === 0, 'the sweep mints the new people — the standing gap for Clayton, none for a sister already named — and skips the ones held');
// the invariant: no write path to the fact graph
const src = fs.readFileSync(path.join(ROOT, 'lib', 'person_model.js'), 'utf8');
ok(!/storeDeduped|graph_entities|insertEntity|recordMany|\.record\(|INSERT INTO (encounters|knowledge)|UPDATE (encounters|knowledge)/.test(src), 'the person model never writes to the fact graph (no such call exists in the module)');
// the wiring: the door on the turn, the ledger on the reply, his answer, the seed, the wondering's gaps, the sweep
const mainS = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8'), ctxS = fs.readFileSync(path.join(ROOT, 'lib', 'context.js'), 'utf8'), slS = fs.readFileSync(path.join(ROOT, 'lib', 'slow_loop.js'), 'utf8'), brS = fs.readFileSync(path.join(ROOT, 'lib', 'consciousness.js'), 'utf8');
ok(/AD\.decide\(\{ socialTurn, gap, turnsSinceLastAsk: PM\.turnsSinceLastAsk\('owner'/.test(mainS) && /askBlock: _askBlock,/.test(mainS) && /askBlock = null \}\) \{/.test(ctxS) && /\$\{askBlock \? '\\n' \+ askBlock : ''\}/.test(ctxS), 'the door decides on the turn and its block rides the social-turn directive');
ok(/const q = AD\.detectQuestion\(finalSaid\);/.test(mainS) && /PM\.ledgerAdd\(\{ turnId: saidRow && saidRow\.id/.test(mainS) && /if \(gapId\) PM\.markAsked\('owner', gapId\);/.test(mainS), 'the reply\'s trailing question is ledgered and stamped on its gap');
ok(/const pend = PM\.ledgerPending\('owner'\);/.test(mainS) && /<= 30 \* 60000 && !\(\(\) => \{ try \{ return require\('\.\/lib\/operator'\)\.isDirectedTask\(userMessage\)/.test(mainS) && /PM\.closeGap\('owner', pend\.gap_id/.test(mainS) && /noteFacts\('owner', stored\.map/.test(mainS), 'his next turn within half an hour, not a work order, answers the question and closes the gap; captured facts close what they cover');
ok(/source = 'personal_fact' ORDER BY created_ts DESC LIMIT 200/.test(mainS) && /PM\.seedOwner\(\{ knownFacts: facts \}\)/.test(mainS), 'his row is seeded at boot from the stored personal facts');
ok(/Things you do not know about him that someone close to him would: \$\{ctx\.gaps\.join/.test(slS) && /if \(msg\.op === 'reflect'\)[^\n]*deps\.gaps/.test(brS) && /deps\.sweepPeople/.test(brS) && /gaps: \(\) => \{ try \{ return require\('\.\/lib\/person_model'\)\.openGaps\('owner', \{ limit: 2 \}\)/.test(mainS) && /sweepPeople: \(\) => \{ try \{ return require\('\.\/lib\/person_model'\)\.sweepThirdParties\(\{ sinceMs: 3600000 \}\)/.test(mainS) && !/person_model/.test(brS), 'the wondering carries the gaps (the live instance injects the model; the bridge never opens the database) and the beat sweeps new people into models');
ok(/CREATE TABLE IF NOT EXISTS person_model/.test(src) && /CREATE TABLE IF NOT EXISTS ask_ledger/.test(src), 'it owns two tables of its own');

console.log(`\nsmoke_person_model: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
