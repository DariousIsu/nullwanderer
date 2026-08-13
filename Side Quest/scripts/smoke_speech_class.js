'use strict';
/* Smoke: lib/speech_class — which unprompted utterances deserve the voice (2026-08-12 truth audit).
 * Cases are the REAL utterances from the audited day (turn ids noted), so this pins the actual
 * traffic, not invented examples. Plus the insertTurn stamp round-trip on a temp DB.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_speech_class.js
 */
const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_speechclass_${Date.now()}.db`);
const db = require('../lib/db'); db.init();
const sc = require('../lib/speech_class');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const C = (s) => sc.classify(s);

// ── RAIL: the template status machinery (robotic as speech; she self-flagged qa-reread, #11645) ──
ok(C("I re-read the document I'm continuing (\"Research — Investigate: What schema does the LAMP 2025 guest\") and judged it against the finished-research bar: …").cls === 'qa-reread'
  && C("I re-read the document I'm continuing…").speak === false, 'qa-reread narration (#11639 etc, 6×/day) → RAIL');
ok(C('Tactics update on the briefing (plan rev 2): added target(s): women\'s body-type classification systems; tactics revised — …').speak === false, 'tactics diff-dump (#11636) → RAIL');
ok(C('Tactics update on the research (plan rev 4): tactics revised — the plan still targets the right objective…').cls === 'tactics', 'tactics matches both research/briefing forms');
ok(C('Steering note on the research: what I just learned raises new questions — How does Southern Power Company\'s wholesale-only model…').speak === false, 'steering-note stream (#11581, 4× in 50min) → RAIL');

// ── SPEAK: the good voice ──
ok(C("It's done — dossier's on your Canvas at `notes/directed-3801-dossier.md` with a Word copy at `.docx`. The single most striking thing: …").cls === 'delivery'
  && C("It's done — dossier's on your Canvas…").speak === true, 'delivery announcement (#11640) → SPEAK');
ok(C('Your dossier is saved on your Canvas at `notes/directed-3792-dossier.md`. The most striking thing I found is…').cls === 'delivery', 'delivery variant (#11591) → SPEAK');
ok(C("The dossier's done and saved at notes/directed-3800-dossier.md — but I need to be straight with you about what it actually contains.").speak === true, 'the refusal disclosure (#11638) → SPEAK');
ok(C("Earlier I said I'd get list together for Lucas, and I haven't actually delivered it yet. Want me to do that now, or keep it on the list?").cls === 'promise', 'promise-keeping nudge (#11573) → SPEAK');
ok(C("I've been thinking about something I committed to a while back—the idea of sticking to my own voice.").cls === 'identity', 'identity musing (#11630) → SPEAK (frequency is the voice layer\'s knob)');

// ── the fail-open default: genuine free speech is never railed ──
ok(C('I can draft the split documents for you to send yourself, or if you want to try another route, just say the word.').cls === 'general'
  && C('I can draft the split documents…').speak === true, 'unrecognized (genuine offer, #11633) → general, SPEAK');
ok(C('A musing that merely MENTIONS the dossier and tactics should not be railed by topic words.').speak === true, 'topic words alone never rail (anchored to template OPENERS only)');
ok(C('').cls === 'general' && C(null).speak === true, 'empty/null → general, speakable (no throw)');
ok(sc.speaks('qa-reread') === false && sc.speaks('delivery') === true && sc.speaks('nonsense-class') === true, 'speaks() = the single source of truth, fail-open on unknown');

// ── the insertTurn stamp round-trip ──
const sess = db.startSession();
const sid = sess && sess.id != null ? sess.id : sess;
const r1 = db.insertTurn({ sessionId: sid, speaker: 'ai_said', content: "I re-read the document I'm continuing (\"x\") and judged it…", unprompted: 1 });
const r2 = db.insertTurn({ sessionId: sid, speaker: 'ai_said', content: "It's done — dossier's on your Canvas at notes/x.md.", unprompted: 1 });
const r3 = db.insertTurn({ sessionId: sid, speaker: 'ai_said', content: 'A normal prompted reply.', unprompted: 0 });
const g = (id) => db.getDb().prepare('SELECT speech_class FROM turns WHERE id = ?').get(id).speech_class;
ok(g(r1.id) === 'qa-reread', 'insertTurn stamped the unprompted qa-reread row');
ok(g(r2.id) === 'delivery', 'insertTurn stamped the unprompted delivery row');
ok(g(r3.id) === null, 'a PROMPTED turn stays null (the voice always carries the conversation)');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
try { db.getDb().close(); } catch {}
process.exit(fail === 0 ? 0 : 1);
