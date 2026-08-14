/* Smoke: lib/lookup_guard — the last door before an auto-derived query reaches a real search
 * engine (post-compact queue #4, 2026-08-14). Two pure predicates:
 *   localAction(say)  — vetoes the promised-lookup net when her announced retrieval's OBJECT is
 *                       one of HER OWN surfaces (store/canvas/roster/doc#) — wrong surface for web.
 *   queryFloor(q)     — coherence floor at the liveLookupAndAnswer funnel: garbled STT, self-echo
 *                       contract fragments, and stutter never reach the engine (search history is
 *                       a conviction record). Errs PERMISSIVE — a false reject silences a lookup.
 * Run: node scripts/smoke_lookup_guard.js */
'use strict';
const lg = require('../lib/lookup_guard');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

console.log('A) localAction — LOCAL promises veto (the wrong-surface class)');
ok(!!lg.localAction("I'm pulling the Hartfield report from our store now."), 'pulling … from our store → LOCAL');
ok(!!lg.localAction("Checking the roster we built for the parish contacts."), 'checking the roster → LOCAL');
ok(!!lg.localAction("Pulling doc #15817 back up for a fresh read."), 'pulling doc #15817 → LOCAL');
ok(!!lg.localAction("Let me go through my notes on the Rainey Center."), 'going through my notes → LOCAL');
ok(!!lg.localAction("I'm checking what we have on him first."), 'checking what we have → LOCAL');
ok(!!lg.localAction("Grabbing it from the vault."), 'from the vault → LOCAL');
ok(!!lg.localAction("Re-reading the canvas draft before I answer."), 're-reading the canvas → LOCAL');

console.log('B) localAction — WEB retrievals must NOT veto (false-positive traps)');
ok(!lg.localAction("I'm pulling current 10-year Treasury yields now."), 'treasury yields → not local');
ok(!lg.localAction("Checking the latest polls out of Louisiana."), 'latest polls → not local');
ok(!lg.localAction("Looking up the Rainey Center's funding sources."), 'looking up funder → not local');
// The clause rule: the RETRIEVAL object is the web's even when a later clause names her canvas.
ok(!lg.localAction("Pulling current Treasury yields now — I'll put them on your canvas after."),
  'web retrieval + later canvas mention → not local (clause-bounded)');
ok(!lg.localAction("Checking when the court files were unsealed."), 'bare "court files" (no possessive) → not local');
ok(!lg.localAction(''), 'empty say → null');

console.log('C) queryFloor — junk REJECTS');
ok(!lg.queryFloor('').ok, 'empty → reject');
ok(!lg.queryFloor('krz bff').ok, 'short garble → reject (too short)');
ok(!lg.queryFloor('krzz bfff mmmt schh').ok, 'vowel-less STT garble → reject');
ok(!lg.queryFloor('the the the the').ok, 'stutter repetition → reject');
ok(!lg.queryFloor('[You just looked up "prices" for Lucas]').ok, 'contract bracket self-echo → reject');
ok(!lg.queryFloor('<div class="x"> chart').ok, 'markup fragment → reject');
ok(!lg.queryFloor('!!!??? --- 123 %%% ###').ok, 'mostly non-letters → reject');
ok(!lg.queryFloor('zzzzzzzt').ok, 'single non-word blurt → reject');

console.log('D) queryFloor — real queries PASS (errs permissive)');
ok(lg.queryFloor('current 10-year Treasury yields').ok, 'normal derived query passes');
ok(lg.queryFloor('Rainey Center funding sources 2026').ok, 'name + year passes');
ok(lg.queryFloor('Bessent').ok, 'single real word (a name) passes');
ok(lg.queryFloor('GDP growth Q2 2026').ok, 'acronym-heavy but real passes (40% tolerance)');
ok(lg.queryFloor('who won the Norway vs England match').ok, 'question-shaped passes');
ok(lg.queryFloor('applied digital data center Ellendale ND').ok, 'entity query passes');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
