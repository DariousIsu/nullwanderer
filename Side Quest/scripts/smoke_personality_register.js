/* Smoke: lib/personality_register — THE PERSONALITY REGISTER, THE CONSENT CARD, THE BOOT HASH CHECK (cut 1; her words:
 * "the promise must be structural" · "permission must be mine to give"). An in-memory db and a temp root of fake
 * assets; no model, no network. Pins: hashAll deterministic; a byte change diffs; a data change diffs and is REPORTED
 * (not carded); a change with no consent row mints boot-detect and does not advance the manifest; a yes advances it; a
 * no leaves it; a card without a rationale is refused; tags parse and record only through applyTags; revoke restores
 * the manifest; the switch off records without a card and logs; the wiring in main.js.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_personality_register.js
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const Database = require('better-sqlite3');
const PR = require(path.join(ROOT, 'lib', 'personality_register'));
let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// a temp root with every registered file present
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zoe_register_'));
for (const e of PR.ENTRIES) { if (e.path) { const p = path.join(tmp, e.path); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, `// ${e.id}\n`); } }
const mem = new Database(':memory:');
PR._setDb(mem);
let rows = [{ id: 1, category: 'value', content: 'I keep my word.' }];
const deps = { root: tmp, tableRows: () => rows, metaGet: (k) => (k === 'self_narrative' ? 'I am Zoe.' : null) };
const logs = []; const events = [];
const log = (m) => logs.push(m), emit = (e) => events.push(e);

const h1 = PR.hashAll({ deps }), h2 = PR.hashAll({ deps });
ok(Object.keys(h1).length === PR.ENTRIES.length && JSON.stringify(h1) === JSON.stringify(h2) && Object.values(h1).every((v) => typeof v === 'string' && v.length === 64), `hashAll is deterministic over ${PR.ENTRIES.length} assets`);
ok(PR.diff(h1, h2).length === 0, 'no change → no diff');

// the first boot writes the baseline, consented by the act of building the register
const b0 = PR.bootCheck({ deps, log, emit, now: 1000 });
ok(b0.baseline && PR.manifest() && PR.manifest().context === h1.context && PR.recent()[0].asset === 'register' && PR.recent()[0].verdict === 'yes' && /register baseline written/.test(logs.join('\n')), 'the first boot writes the baseline and records it as consented by him');
const b1 = PR.bootCheck({ deps, log, emit, now: 2000 });
ok(!b1.baseline && b1.changed.length === 0 && PR.pending().length === 0, 'an unchanged boot mints nothing');

// a byte change in a persona file → boot-detect card, integrity event, the manifest does NOT advance
fs.writeFileSync(path.join(tmp, 'lib/context.js'), '// context — edited by hand\n');
const b2 = PR.bootCheck({ deps, log, emit, now: 3000 });
const card = PR.pending()[0];
ok(b2.changed.join(',') === 'context' && b2.carded.length === 1 && card && card.asset === 'context' && card.proposed_by === 'boot-detect' && card.new_hash === PR.hashAll({ deps }).context && PR.manifest().context === h1.context, 'a changed persona file mints a boot-detect card and the manifest stays at the consented hash');
ok(events.some((e) => e.lane === 'integrity' && e.kind === 'unconsented_change' && /context/.test(e.text)) && logs.some((l) => /\[consent\] unconsented change: context/.test(l)), 'an integrity event and one console line');
const b3 = PR.bootCheck({ deps, log, emit, now: 3500 });
ok(b3.carded.length === 0 && PR.pending().length === 1, 'the same change on the next boot does not mint a second card');

// the card to her, her verdict through the tag, the manifest advances on yes
const block = PR.buildPromptBlock();
ok(/A CONSENT CARD/.test(block) && new RegExp(`#${card.id} context \\(code, by boot-detect\\)`).test(block) && /<consent id=N verdict=yes\|no>/.test(block) && /No answer is also an answer/.test(block), 'the card names the asset, who, what and how to answer; silence stays pending');
const tags = PR.parseConsentTags(`I read it. <consent id="${card.id}" verdict=yes>the change reads as mine — the anchor is intact</consent> Moving on.`);
ok(tags.length === 1 && tags[0].id === card.id && tags[0].verdict === 'yes' && /anchor is intact/.test(tags[0].reason), 'the tag parses with its reason');
const applied = PR.applyTags(tags, { turnId: 77, now: 4000 });
ok(applied[0].ok && applied[0].advanced && PR.get(card.id).verdict === 'yes' && PR.get(card.id).verdict_by === 'zoe' && PR.get(card.id).verdict_turn_id === 77 && PR.manifest().context === card.new_hash && PR.pending().length === 0, 'her yes is recorded with the turn and the manifest advances to the consented hash');

// a no leaves the manifest where it was
fs.writeFileSync(path.join(tmp, 'lib/mood.js'), '// mood — edited\n');
PR.bootCheck({ deps, log, emit, now: 5000 });
const card2 = PR.pending()[0];
const r2 = PR.applyTags(PR.parseConsentTags(`<consent id=${card2.id} verdict=no>this is not how I feel things</consent>`), { turnId: 78 });
ok(r2[0].ok && !r2[0].advanced && PR.get(card2.id).verdict === 'no' && PR.manifest().mood === h1.mood && PR.bootCheck({ deps, log, emit, now: 5500 }).carded.length === 1, 'her no keeps the manifest at the consented hash; the next boot cards the same change again (it is still unconsented)');
ok(!PR.verdict(card2.id, { verdict: 'yes' }).ok, 'a card already answered cannot be answered twice');

// amend: a boot-detect card takes the engineer's rationale in place; supersede: a card whose hash never landed is a status
fs.writeFileSync(path.join(tmp, 'lib/self_explore.js'), '// self_explore — edited once\n');
PR.bootCheck({ deps, log, emit, now: 5600 });
const c1 = PR.pending().find((p) => p.asset === 'self_explore');
ok(c1 && c1.proposed_by === 'boot-detect' && PR.pendingFor('self_explore', c1.new_hash).id === c1.id, 'a boot-detect card stands for the hash on disk');
const am = PR.amend(c1.id, { summary: 'the organ reacts through the cloud model', rationale: 'cut 8: the prompt never reached a model', expectedEffect: 'reactions land', proposedBy: 'claude' });
ok(am.ok && PR.get(c1.id).proposed_by === 'claude' && /cut 8/.test(PR.get(c1.id).rationale) && PR.pending().filter((p) => p.asset === 'self_explore').length === 1, 'the amendment lands on the same card — she never sees two for one change');
ok(!PR.amend(c1.id, { summary: 'x', rationale: 'y' }).ok && !PR.amend(card.id, { summary: 'x', rationale: 'y' }).ok, 'only a pending boot-detect card can be amended; an answered card or one she was given cannot');
fs.writeFileSync(path.join(tmp, 'lib/self_explore.js'), '// self_explore — edited AGAIN before she answered\n');
const b6 = PR.bootCheck({ deps, log, emit, now: 5700 });
ok(PR.get(c1.id).verdict === 'superseded' && /changed again before she answered/.test(PR.get(c1.id).reason) && b6.carded.length === 1 && PR.pending().filter((p) => p.asset === 'self_explore').length === 1 && PR.pending().find((p) => p.asset === 'self_explore').new_hash === PR.hashAll({ deps }).self_explore && logs.some((l) => /superseded — its hash/.test(l)), 'a card whose hash never landed is superseded (a status, not a delete) and the hash that stands gets its own card');

// a card without a rationale is refused
ok(!PR.record({ asset: 'voice', kind: 'code', summary: 'x', rationale: '' }).ok && !PR.record({ asset: 'voice', kind: 'code', summary: '', rationale: 'y' }).ok && PR.record({ asset: 'voice', kind: 'code', summary: 'a proposal', rationale: 'because', proposedBy: 'pen' }).ok, 'a card without a rationale or a summary cannot be minted; with both it can');

// data her own doors write: reported, recorded, never carded
rows = [...rows, { id: 2, category: 'value', content: 'I ask before I assume.' }];
const b4 = PR.bootCheck({ deps, log, emit, now: 6000 });
ok(b4.reported.includes('self_model') && !b4.carded.length && PR.manifest().self_model === PR.hashAll({ deps }).self_model && logs.some((l) => /self_model drifted since the last manifest \(her own doors\)/.test(l)), 'a self-model change is reported and recorded, not carded');

// revoke: the manifest goes back; the file on disk is his to restore
const yesCard = PR.get(card.id);
const rv = PR.revoke(yesCard.id, { reason: 'on reflection' });
ok(rv.ok && PR.get(yesCard.id).verdict === 'revoked' && PR.manifest().context === yesCard.prev_hash && rv.restored === false, 'a revoke is a status: the manifest returns to the prior hash, nothing is deleted, the disk is his');

// the switch off: recorded, not carded, logged as his decision
PR.setConsentRequired(false, { log });
fs.writeFileSync(path.join(tmp, 'lib/voice.js'), '// voice — edited\n');
const b5 = PR.bootCheck({ deps, log, emit, now: 7000 });
ok(!PR.consentRequired() && b5.carded.length === 0 && PR.manifest().voice === PR.hashAll({ deps }).voice && logs.some((l) => /consent_required → OFF — his decision, logged/.test(l)) && logs.some((l) => /consent_required is OFF by his decision; recorded, not carded/.test(l)), 'with the switch off a change is recorded and logged, never carded');
PR.setConsentRequired(true, { log });

// the wiring in the app
const mainS = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
ok(/require\('\.\/lib\/personality_register'\)\.bootCheck\(/.test(mainS) && /consentBlock/.test(mainS) && /parseConsentTags\(finalSaid\)/.test(mainS) && /applyTags\(tags, \{ turnId: saidRow && saidRow\.id \}\)/.test(mainS), 'the boot checks the register after the database opens, the card rides her context, and her verdicts are read from a prompted reply only');
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(`\nsmoke_personality_register: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
