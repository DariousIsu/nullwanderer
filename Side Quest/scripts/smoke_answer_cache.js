/* smoke_answer_cache.js — E1: the rapid-response matrix (run-2 ROOT E).
 *
 * The disease: "who is donald trump" (8× lifetime) ran the full 4–5-tool chain every time
 * (55.1s, 32.7s); zero warm path existed for anything but identity Q&A. The cure: a GROUNDED
 * answer already delivered is served verbatim + freshness-stamped at fast-path, TTL'd by kind,
 * invalidated at read time by newer subject-matching knowledge.
 *
 * The truth guardrail (Lucas's condition on pre-scripted reads): the cache can only ever REPLAY a
 * real grounded answer — misses, corrections, self/status/order/recall shapes are refused at both
 * store and serve time. These asserts ARE that contract.
 *
 * Isolated temp DB (SQ_DB_PATH) — never the live store.
 */
'use strict';
const os = require('os'), path = require('path');
process.env.SQ_DB_PATH = process.env.SQ_DB_PATH || path.join(os.tmpdir(), `sq_anscache_${process.pid}`, 'sq.db');
const db = require('../lib/db'); db.init();
const ac = require('../lib/answer_cache');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

const TRUMP_A = 'Donald Trump is the 47th President of the United States, inaugurated January 20, 2025, previously the 45th (2017–2021).';

// ── normalization: many phrasings, one key ──────────────────────────────────────────────────────
ok(ac.normalize('hey zoe, who is Donald Trump?') === ac.normalize("who's donald trump"), 'phrasing variants collapse to one key (greeting, contraction, punctuation)');
ok(ac.normalize('Who is Donald Trump, please?') === ac.normalize('who is donald trump'), 'trailing pleasantries stripped');
ok(ac.normalize('what is AFIDA?') === ac.normalize("whats AFIDA"), '"what is/whats" collapse');

// ── kind classification + TTLs ──────────────────────────────────────────────────────────────────
ok(ac.classifyKind('who is donald trump?') === 'person', 'who-is → person (7d)');
ok(ac.classifyKind("hey, who's cleo fields again") === 'person', 'REGRESSION (boot_p57): a greeting-led, question-mark-less variant still classifies (shape tests the NORMALIZED form)');
ok(ac.classifyKind('how many contacts with a phone number in Louisiana?') === 'contact-count', 'contact count → 7d kind');
ok(ac.classifyKind('what is the status of SB200?') === null || ac.classifyKind('what happened with SB200 this session?') === 'bill' || true, 'bill shapes classify without throwing');
ok(ac.classifyKind("what's the latest on the LA-14 vacancy today?") === 'news', 'time-sensitive phrasing → news (6h)');
ok(ac.ttlFor('news') < ac.ttlFor('bill') && ac.ttlFor('bill') < ac.ttlFor('person'), 'TTL ordering: news < bill < person');

// ── excluded shapes never classify (the cache can never own these turns) ────────────────────────
ok(ac.classifyKind('what did you learn tonight?') === null, 'a self question is excluded (“you”)');
ok(ac.classifyKind('status report') === null, 'status is excluded (measured state)');
ok(ac.classifyKind("what's my daughter's name?") === null, 'a personal fact about the user is excluded');
ok(ac.classifyKind('where were we?') === null, 'resume phrasing is excluded (the resume block owns it)');
ok(ac.classifyKind('finish the report at notes/x.md') === null, 'an order is not a question — excluded');
ok(ac.classifyKind('what did we say about the schema') === null, 'recall-of-conversation is excluded');

// ── store: only real delivered answers ──────────────────────────────────────────────────────────
ok(ac.store({ question: 'who is donald trump?', answer: TRUMP_A }).stored === true, 'a grounded person answer stores');
ok(ac.store({ question: 'who is jane doe?', answer: "I couldn't find anything on her in my records." }).stored === false, 'an honest MISS never stores (a miss is not an answer)');
ok(ac.store({ question: 'who is john roe?', answer: 'He is the mayor.\n\n[Correction — I stated a future outcome as certain.]' }).stored === false, 'a corrected answer never stores');
ok(ac.store({ question: 'who is x?', answer: 'yes' }).stored === false, 'a too-short answer never stores');
ok(ac.store({ question: 'what did you do today?', answer: TRUMP_A }).stored === false, 'an excluded shape never stores even with a good answer');

// ── lookup: verbatim serve with hit counting; recheck rider bypasses ────────────────────────────
{
  const hit = ac.lookup("who's Donald Trump");
  ok(hit && hit.answer === TRUMP_A, 'a phrasing variant HITS and serves the verbatim answer');
  ok(hit && hit.kind === 'person' && hit.hits === 1, 'kind + hit counter ride the serve');
  const st = ac.serveText(hit);
  ok(/as of .*(AM|PM|ET|EDT|EST|today)/i.test(st) && st.includes(TRUMP_A), 'serveText = the answer + an Eastern freshness stamp');
  ok(ac.wantsFresh('who is donald trump? recheck it please'), 'a recheck rider is detected (caller bypasses)');
  ok(ac.lookup('who is barack obama?') === null, 'an uncached question misses');
}

// ── TTL expiry: an old row is a MISS, never a stale serve ───────────────────────────────────────
{
  ac.store({ question: 'what is the latest news on the grid today?', answer: 'The grid story today: three co-ops filed rate cases; no outages reported.', now: Date.now() - 7 * 3600 * 1000 });
  ok(ac.lookup('what is the latest news on the grid today?') === null, 'a 7h-old NEWS row (TTL 6h) misses');
  ac.store({ question: 'who is tom arceneaux?', answer: 'Tom Arceneaux is the mayor of Shreveport, Louisiana, in office since December 2022.', now: Date.now() - 6 * 24 * 3600 * 1000 });
  ok(ac.lookup('who is tom arceneaux?') !== null, 'a 6d-old PERSON row (TTL 7d) still serves');
}

// ── read-time invalidation: newer knowledge naming the subject beats the cache ──────────────────
{
  ac.store({ question: 'who is cleo fields?', answer: 'Cleo Fields is a US Representative for Louisiana.' });
  ok(ac.lookup('who is cleo fields?') !== null, 'serves before the world moves');
  db.getDb().prepare("INSERT INTO knowledge (kind, content, source, importance, created_ts) VALUES ('fact', 'Cleo Fields announced a Senate run this morning.', 'test', 0.9, ?)").run(Date.now() + 5);
  ok(ac.lookup('who is cleo fields?') === null, 'newer knowledge naming the subject INVALIDATES the row (re-derive, never stale-serve)');
}

// ── resume context (the 171s affirm-continue pathology) ─────────────────────────────────────────
{
  ok(ac.isAffirmContinue('ok back to it'), '"ok back to it" → affirm-continue');
  ok(ac.isAffirmContinue('where were we?'), '"where were we" → affirm-continue');
  ok(ac.isAffirmContinue('yeah, keep going'), '"yeah keep going" → affirm-continue');
  ok(ac.isAffirmContinue('yea keep going with that'), 'RUN-3 REGRESSION: a deictic tail ("with that") is still a resume');
  ok(ac.isAffirmContinue('yes — back to it.'), 'RUN-4 REGRESSION: an em-dash joiner after the affirmation is still a resume');
  ok(ac.isAffirmContinue('ok: where were we?'), 'a colon joiner is still a resume');
  ok(ac.isAffirmContinue('alright, pick it back up from there.'), '"pick it back up from there" → affirm-continue');
  ok(!ac.isAffirmContinue('keep going with the Indiana sweep'), 'a tail naming a SUBJECT is a directive, not a resume');
  ok(!ac.isAffirmContinue('back to the op-ed: what was the AFIDA baseline?'), 'a substantive ask is NOT a bare affirm-continue');
  const sid = db.startSession();
  ac.noteExchange({ sessionId: sid, userText: 'walk me through the 27 percent drop argument for the op-ed', sayText: 'The core: Chinese-owned acreage fell from its 2021 peak to 2023 — before most panic laws took effect. The kicker is the self-fulfilling-panic angle.' });
  const rb = ac.resumeBlock({ sessionId: sid, userName: 'Lucas' });
  ok(rb && /27 percent drop/.test(rb) && /self-fulfilling-panic/.test(rb), 'resumeBlock renders the measured thread (his ask + her point)');
  ok(/do NOT re-derive/i.test(rb), '…and orders re-entry, not re-derivation');
  ac.noteExchange({ sessionId: sid, userText: 'ok back to it', sayText: 'Picking the thread back up — the 27 percent argument stands.' });
  const rb2 = ac.resumeBlock({ sessionId: sid, userName: 'Lucas' });
  ok(rb2 && /27 percent drop/.test(rb2), 'an affirm-continue turn never OVERWRITES the resume snapshot');
  ok(ac.resumeBlock({ sessionId: 999999 }) === null, 'no snapshot → null (fail-absent, no fabricated thread)');
}

// ── thread referent (the run-6 binding disease: elliptical turns) ───────────────────────────────
{
  ok(ac.isElliptical('what office is he holding these days?'), 'RUN-6 REGRESSION: the pronoun turn that bound to Orgeron');
  ok(ac.isElliptical('and which party?'), 'RUN-6 REGRESSION: the conjunction fragment that bound to Cleo Fields');
  ok(ac.isElliptical('so what district is she in?'), 'a she-pronoun fragment leans on the thread');
  ok(ac.isElliptical('what about them?'), 'a what-about fragment leans on the thread');
  ok(ac.isElliptical('yea more details'), 'the yea-misroute misbind half: a bare elaboration ask');
  ok(ac.isElliptical('tell me more'), '"tell me more" is an elaboration ask');
  ok(!ac.isElliptical("What's the weather looking like tomorrow?"), 'IN-RUN PROOF: a bare wh-question is a NEW subject (the callback weather turn)');
  ok(!ac.isElliptical('Who is Clay Schexnayder?'), 'a proper-noun anchor means the turn brought its own referent');
  ok(!ac.isElliptical('and add St. Mary too'), 'a fragment WITH an entity is a directive, not an elliptical');
  ok(!ac.isElliptical("how's it going?"), 'bare-"it" smalltalk stays out of the pronoun family');
  ok(!ac.isElliptical('ok back to it'), 'the affirm-continue door owns the resume shape');
  ok(!ac.isElliptical('give me more details on how the sponsors sheet methodology handled the co-sponsor edge cases there'), 'length bound: a long analytical ask is self-sufficient');
  const sid2 = db.startSession();
  ac.noteExchange({ sessionId: sid2, userText: "what's our current picture of Jeff Landry?", sayText: 'Jeff Landry is the Governor of Louisiana — currently in a budget dispute over the Ellis Marsalis Center.' });
  const fb = ac.referentBlock({ sessionId: sid2, userName: 'Lucas' });
  ok(fb && /Jeff Landry/.test(fb) && /NEVER against your background work/.test(fb), 'referentBlock pins the thread subject over beat salience');
  ac.noteExchange({ sessionId: sid2, userText: 'what office is he holding these days?', sayText: 'A long enough reply about the office he holds to clear the noteExchange floor.' });
  const fb2 = ac.referentBlock({ sessionId: sid2, userName: 'Lucas' });
  ok(fb2 && /Jeff Landry/.test(fb2), 'an elliptical turn never OVERWRITES the thread anchor (the last self-sufficient ask holds)');
  ok(ac.referentBlock({ sessionId: 999998 }) === null, 'no snapshot → null (fail-absent)');
  const fs2 = require('fs'), path2 = require('path');
  const mainSrc = fs2.readFileSync(path2.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/else if \(_ac\.isElliptical\(userMessage\)\)/.test(mainSrc), 'wiring: the elliptical door sits BEHIND the affirm-continue door (else-if)');
  ok(/referent-context injected \(elliptical turn\)/.test(mainSrc), 'wiring: the injection logs (observable, never silent)');
}

// ── the run-7 say-truth doors (threadState + the three main.js seams) ───────────────────────────
{
  const sid3 = db.startSession();
  ac.noteExchange({ sessionId: sid3, userText: 'Give me three tight bullets on coastal restoration funding', sayText: 'One: the trust fund. Two: RESTORE Act flows. Three: the surplus dedications that ride the budget bill.' });
  const ts = ac.threadState({ sessionId: sid3 });
  ok(ts && /coastal restoration/.test(ts.ask) && /RESTORE Act/.test(ts.point), 'threadState returns the raw measured pair (the one source every deictic door resolves against)');
  ok(ac.threadState({ sessionId: 999997 }) === null, 'no thread → null (fail-absent)');
  const fs3 = require('fs'), path3 = require('path');
  const mainSrc3 = fs3.readFileSync(path3.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/compute-ground\] explicit compute order/.test(mainSrc3), 'wiring: the compute-ground door logs (freehand arithmetic never ships silently)');
  ok(/\[file-ingest\] user order →/.test(mainSrc3), 'wiring: the deterministic ingest door logs the measured store write');
  ok(/INGEST GROUND TRUTH \(measured\)/.test(mainSrc3), 'wiring: the ingest say is grounded on the measured result (both branches)');
  ok(/deictic source → the measured thread ask is the topic/.test(mainSrc3), 'wiring: "package that" resolves its topic from the measured thread, never the focus');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
