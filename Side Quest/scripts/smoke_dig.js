/* Smoke: lib/dig — the MID-CONVERSATION DIG (slice 4b). Deterministic: pure parse/strip/addressing/
 * judgment/message logic + an inquiry round-trip on an in-memory db. No model/network/live db.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_dig.js
 */
'use strict';
const dig = require('../lib/dig');
const inquiry = require('../lib/inquiry');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- parse: complete pairs only ---
const tags = dig.parseDigTags('sure — let me look. <dig>Which Nebraska counties replaced their election commissioners since 2024?</dig> back in a few.');
ok(tags.length === 1 && /Nebraska counties/.test(tags[0].question), 'a complete <dig> pair parses to its question');
ok(dig.parseDigTags('you can use <dig> to fork research').length === 0, 'format narration (unclosed tag) can never produce a dispatch');
ok(dig.parseDigTags('<dig>too short</dig>').length === 0, 'a sub-sentence scrap is refused at parse (inquiry.open would refuse it anyway)');
const multi = dig.parseDigTags('<dig>What changed in the Fulton County board since the primary?</dig> and <dig>Who funds the Antelope County recall effort?</dig>');
ok(multi.length === 2, 'multiple pairs in one turn all parse (the dispatch guard, not the parser, bounds the fork count)');
ok(dig.parseDigTags('<dig>  a   question\n with   messy\twhitespace inside?  </dig>')[0].question === 'a question with messy whitespace inside?',
  'whitespace normalizes — the question reads as one line');

// --- strip: pairs and orphans both leave the display ---
const stripped = dig.stripDigTags('here is what I know now. <dig>Which vendors run Georgia county election sites?</dig> more soon.');
ok(!/<dig>/i.test(stripped) && /here is what I know now\. {1,2}more soon\./.test(stripped.replace(/\s+/g, ' ')), 'the pair strips clean from the spoken reply');
ok(dig.stripDigTags('a truncated </dig> orphan') === 'a truncated  orphan', 'an orphan close tag strips too (truncation never leaks markup)');

// --- addressing (§6 L1): born_from carries the turn; isConversationBorn reads it back ---
const bf = dig.bornFrom(3542, 'do you know which counties changed hands after the recall wave?');
ok(/^conversation turn #3542 — "/.test(bf), 'born_from names the asking turn');
ok(dig.bornFrom(7, 'x'.repeat(400)).length <= 160, 'born_from respects the column bound');
ok(dig.isConversationBorn({ born_from: bf }), 'a dig-born row reads as conversation-born');
ok(!dig.isConversationBorn({ born_from: 'her own state' }) && !dig.isConversationBorn({}) && !dig.isConversationBorn(null),
  "the tick's own inquiries never read as conversation-born");

// --- the header tells the touch where the question was born ---
ok(/FORKED FROM A LIVE CONVERSATION/.test(dig.digHeader({ born_from: bf })) && dig.digHeader({ born_from: bf }).includes('#3542'),
  'the touch header carries the return address');

// --- hasRealFinding: what earns the homecoming mark ---
ok(dig.hasRealFinding({ status: 'continue', new_evidence: [{ gist: 'found the vendor list', cite: 'sos.ga.gov' }] }), 'evidence = a real finding');
ok(dig.hasRealFinding({ status: 'answered', new_evidence: [] }), 'a resolved question is a real finding even without fresh evidence');
ok(dig.hasRealFinding({ status: 'dead_end', new_evidence: [] }), 'an honest dead end is a real finding (the promise is an answer, not good news)');
ok(!dig.hasRealFinding({ status: 'continue', new_evidence: [] }), 'a dry continue is NOT — the homecoming stays owed');
ok(!dig.hasRealFinding(null), 'no write-back is not a finding');

// --- returnFallback: honest in every shape ---
const q = 'Which vendors run Georgia county election sites?';
ok(/About what you asked/.test(dig.returnFallback({ question: q, env: null })) && /keep working it/.test(dig.returnFallback({ question: q, env: null })),
  'no write-back → an honest empty-handed return that keeps the question open');
const found = dig.returnFallback({ question: q, env: { learned: 'Three vendors cover 142 of 159 counties.', status: 'continue', new_evidence: [{ gist: 'x', cite: 'sos.ga.gov' }, { gist: 'y', cite: '' }] } });
ok(/here's what I found/.test(found) && /Three vendors/.test(found) && /sos\.ga\.gov/.test(found), 'a finding returns substance + its sources');
ok(/don't think it's answerable/.test(dig.returnFallback({ question: q, env: { learned: 'No public record ties vendors to sites.', status: 'dead_end', new_evidence: [] }, closedStatus: 'closed_dead_end' })),
  'a dead end says so plainly');
ok(/still open/.test(dig.returnFallback({ question: q, env: { learned: 'First pass found only marketing pages.', status: 'continue', new_evidence: [] } })),
  'a dry continue admits it and names the board');

// --- returnPromptParts: grounded, honest empties ---
const p = dig.returnPromptParts({ question: q, env: { learned: 'Three vendors.', status: 'continue', new_evidence: [{ gist: 'vendor A covers 90 counties', cite: 'gasos' }] }, uname: 'Lucas' });
ok(/about the X you asked/.test(p.sys) && /do not invent/.test(p.sys), 'the voice prompt anchors to the ask and forbids fabrication');
ok(/vendor A covers 90 counties/.test(p.user) && /THE QUESTION/.test(p.user), 'the user half carries the real evidence');
ok(/EVIDENCE: none this touch\./.test(dig.returnPromptParts({ question: q, env: { learned: 'dry', status: 'continue', new_evidence: [] } }).user),
  'an empty evidence set is stated, never padded');
ok(/no write-back/.test(dig.returnPromptParts({ question: q, env: null }).user), 'a missing write-back is named honestly');

// --- live rail: open-with-born_from round-trips through lib/inquiry on an in-memory db ---
const Database = require('better-sqlite3');
const mem = new Database(':memory:');
mem.exec(`CREATE TABLE inquiries (id INTEGER PRIMARY KEY, question TEXT NOT NULL, born_from TEXT,
  status TEXT NOT NULL DEFAULT 'active', evidence TEXT, gist TEXT, open_leads TEXT, next_step TEXT,
  touches INTEGER NOT NULL DEFAULT 0, expect_trail TEXT, created_ts INTEGER NOT NULL,
  last_touched_ts INTEGER, closed_ts INTEGER, answer TEXT, dig_delivered_ts INTEGER)`);
const deps = { db: { getDb: () => mem } };
const o = inquiry.open({ question: multi[0].question, bornFrom: dig.bornFrom(99, 'what changed in Fulton since the primary?'), deps, nowMs: 1000 });
ok(!!o.id, 'a parsed dig question opens as a real inquiry');
const row = inquiry.get(o.id, { deps });
ok(dig.isConversationBorn(row), 'the stored row reads back as conversation-born (the address rides the object)');
ok(row.dig_delivered_ts == null, 'the homecoming starts owed (dig_delivered_ts NULL)');
ok(/FORKED FROM A LIVE CONVERSATION/.test(dig.digHeader(row)) && /LINE OF INQUIRY #/.test(inquiry.touchBrief(row)),
  'header + touchBrief compose into the dig touch the operator actually receives');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
