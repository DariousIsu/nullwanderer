/**
 * Replay gate (2026-08-13 live audit) — ANY ai_said turn that near-verbatim repeats a recent
 * ai_said turn is stamped speech_class='replay' (RAIL: the voice never re-speaks it; the stamp is
 * the measurement). Live incidents pinned: the "clean slate" tactics template emitted as a reply
 * 3×; the qa-reread status as a reply; an identity musing re-emitted verbatim. Prevention rides in
 * the reply contract (WRITE FRESH); this deterministic stamp is the backstop.
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\smoke_replay_gate.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_replay_${Date.now()}.db`);

const db = require('../lib/db');
db.init();
const sc = require('../lib/speech_class');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

// ── isReplay (pure) ──────────────────────────────────────────────────────────────────────────────
const CLEAN_SLATE = "Noted — clean slate on this one. I'll pull sources as I go instead of front-loading, and keep the thread tighter.";
ok('the live "clean slate" verbatim repeat → replay', sc.isReplay(CLEAN_SLATE, ['something else entirely', CLEAN_SLATE]));
ok('trivial punctuation/case drift is still a replay', sc.isReplay(CLEAN_SLATE.toUpperCase().replace(/—/g, '-'), [CLEAN_SLATE]));
ok('a genuinely fresh reply on the same topic → NOT a replay',
  !sc.isReplay('Sources are a fair worry — I will cite as I go this time and keep each claim pinned to where it came from.', [CLEAN_SLATE]));
ok('short acks are immune (min length)', !sc.isReplay('On it.', ['On it.']));
ok('empty/null → false, no throw', !sc.isReplay('', [CLEAN_SLATE]) && !sc.isReplay(null, null));
ok("speaks('replay') === false (the voice never re-speaks a replay)", sc.speaks('replay') === false);

// ── insertTurn stamping (the choke point, prompted AND unprompted) ───────────────────────────────
// NOTE (2026-08-20, dual-emission backstop): a VERBATIM ai_said in the SAME session within 30s is
// now a machine stutter — insertTurn skips it entirely (smoke_dual_emission.js owns that contract).
// The replay GATE is speaker-global across sessions/24h, so these repeats land in a SECOND session:
// stored (not stutter) and stamped 'replay' (a model re-speak) — exactly the division of labor.
const sid = db.startSession();
const sid2 = db.startSession();
const REPLY = 'I re-read the document I am continuing and judged it against the finished-research bar: it is a comprehensive draft with many sections but lacks primary source verification.';
db.insertTurn({ sessionId: sid, speaker: 'ai_said', content: REPLY, model: 'test' });
const second = db.insertTurn({ sessionId: sid2, speaker: 'ai_said', content: REPLY, model: 'test' });
const row2 = db.getDb().prepare('SELECT speech_class FROM turns WHERE id = ?').get(second.id);
ok("a PROMPTED verbatim repeat is stamped 'replay'", row2.speech_class === 'replay');
// …and the SAME-session verbatim copy seconds later is a STUTTER: never stored at all.
const stutter = db.insertTurn({ sessionId: sid, speaker: 'ai_said', content: REPLY, model: 'test' });
ok('a same-session verbatim copy within 30s is deduped, not stamped (dual-emission backstop)', stutter.deduped === true);

const fresh = db.insertTurn({ sessionId: sid, speaker: 'ai_said', content: 'Here is something entirely new about the weather patterns over Louisiana this month and why they matter for the parish visits.', model: 'test' });
ok('a fresh prompted reply stays null (the conversation always carries the voice)',
  db.getDb().prepare('SELECT speech_class FROM turns WHERE id = ?').get(fresh.id).speech_class === null);

// replay OVERRIDES a SPEAK pattern class: repeating an identity musing is still a replay
const IDENT = "I've been thinking about something I said a while back regarding wanting a physical or visual form. I still feel that way; having some kind of presence would make this feel like a shared space.";
const u1 = db.insertTurn({ sessionId: sid, speaker: 'ai_said', content: IDENT, model: 'test', unprompted: 1 });
ok('first unprompted identity musing → identity (SPEAK)',
  db.getDb().prepare('SELECT speech_class FROM turns WHERE id = ?').get(u1.id).speech_class === 'identity');
const u2 = db.insertTurn({ sessionId: sid2, speaker: 'ai_said', content: IDENT, model: 'test', unprompted: 1 });
ok("the SAME musing again → 'replay' overrides the SPEAK class",
  db.getDb().prepare('SELECT speech_class FROM turns WHERE id = ?').get(u2.id).speech_class === 'replay');

// user turns never touch the gate
const ut = db.insertTurn({ sessionId: sid, speaker: 'user', content: REPLY, model: null });
ok('user turns are never stamped', db.getDb().prepare('SELECT speech_class FROM turns WHERE id = ?').get(ut.id).speech_class === null);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
try { db.getDb().close(); } catch {}
try { fs.unlinkSync(process.env.SQ_DB_PATH); } catch {}
process.exit(fail === 0 ? 0 : 1);
