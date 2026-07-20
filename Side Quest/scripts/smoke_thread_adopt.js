/* smoke_thread_adopt.js — thread adoption + honest carrying (personality ↔ memory-ecosystem fit).
 *
 * The load-bearing tests are the REFUSALS. A wrong adoption attaches a research beat's work to an
 * unrelated promise Lucas made — worse than the duplicate it replaces — so the matcher must decline
 * on weak evidence rather than guess. The live failure this fixes: his "compile leadership and
 * historical data for all Louisiana parishes" sat 8 days untouched with action_count 0, pinned at
 * the top of every prompt, while an identical machine-minted thread did the work.
 */
'use strict';
const ot = require('../lib/open_threads');
const beats = require('../lib/beats');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

const LA = { stateName: 'Louisiana', nouns: ['parish', 'parishes'] };
const T = (id, content, over = {}) => ({
  id, content, status: 'pending', source_turn_id: 1000 + id, parent_id: null,
  mention_count: 0, last_touched_ts: Date.now(), ...over,
});

(async () => {
  // ── beatScope: structural, derived from stateCode ────────────────────────────────────────────
  {
    const s = beats.beatScope(beats.countyCommissionBeat('LA'));
    ok(s && s.stateName === 'Louisiana', 'beatScope: LA → Louisiana');
    ok(s && s.nouns.includes('parish') && s.nouns.includes('parishes'), 'beatScope: LA noun is parish/parishes');
    const ak = beats.beatScope(beats.countyCommissionBeat('AK'));
    ok(ak && ak.nouns.includes('borough') && ak.nouns.includes('boroughs'), 'beatScope: AK → borough(s)');
    ok(beats.beatScope({ id: 'topic-ai' }) === null, 'beatScope: no stateCode → null (adoption declines)');
    ok(beats.beatScope(null) === null, 'beatScope(null) → null, no throw');
  }

  // ── the adoption that should happen ──────────────────────────────────────────────────────────
  {
    const threads = [
      T(1, 'monitor the Norway vs England world cup match for Lucas'),
      T(2, 'compile leadership and historical data for all Louisiana parishes'),
      T(3, 'map county level governments state by state for Lucas'),
    ];
    const m = ot.matchCarriedThread(LA, threads);
    ok(m.adopt && m.adopt.id === 2, 'adopts the Louisiana parish thread');
    ok(m.duplicates.length === 0, 'no duplicates when only one qualifies');
  }

  // ── REFUSALS (the load-bearing half) ─────────────────────────────────────────────────────────
  {
    ok(ot.matchCarriedThread(LA, [T(1, 'monitor the Norway vs England world cup match')]).adopt === null,
      'SAFETY: unrelated commitment is NOT adopted');
    ok(ot.matchCarriedThread(LA, [T(1, 'map county level governments state by state for Lucas')]).adopt === null,
      'SAFETY: no state anchor → declines (would have stolen a nationwide request)');
    ok(ot.matchCarriedThread(LA, [T(1, 'book a flight to Louisiana for Lucas')]).adopt === null,
      'SAFETY: state named but not about governing bodies → declines');
    // REGRESSION: a live dry run merged this into the parish-leadership commitment because the
    // governance vocabulary included the weak word "contacts". State anchor + a weak word is not
    // evidence of the same commitment.
    ok(ot.matchCarriedThread(LA,
      [T(1, 'conservative think tanks or activist groups in Louisiana — gather: organizations and contacts')]).adopt === null,
      'SAFETY: "Louisiana … contacts" does NOT qualify — weak words are not anchors');
    ok(ot.matchCarriedThread(LA, [T(1, 'compile the Louisiana parish leadership roster')]).adopt !== null,
      'control: the real commitment still adopts via its scope noun');
    ok(ot.matchCarriedThread({ stateName: '', nouns: [] }, [T(1, 'Louisiana parish commissioners')]).adopt === null,
      'SAFETY: no scope anchor → never adopts');
    ok(ot.matchCarriedThread(LA, [T(1, 'Louisiana parish leadership', { source_turn_id: null })]).adopt === null,
      'SAFETY: machine-minted thread (no source turn) is not a commitment to adopt');
    ok(ot.matchCarriedThread(LA, [T(1, 'Louisiana parish leadership', { status: 'resolved' })]).adopt === null,
      'SAFETY: resolved thread not adopted');
    ok(ot.matchCarriedThread(LA, [T(1, 'Louisiana parish leadership', { parent_id: 9 })]).adopt === null,
      'SAFETY: already-merged child not adopted again');
    ok(ot.matchCarriedThread(LA, []).adopt === null, 'empty thread list → null');
    ok(ot.matchCarriedThread(null, null).adopt === null, 'bad input → null, no throw');
    // word-boundary, not substring: "Iowan" must not satisfy the "Iowa" anchor by accident
    ok(ot.matchCarriedThread({ stateName: 'Iowa', nouns: ['county'] },
      [T(1, 'research Iowan county fair traditions')]).adopt === null,
      'SAFETY: anchor matches on word boundaries — "Iowan" is not "Iowa"');
    ok(ot.matchCarriedThread({ stateName: 'Iowa', nouns: ['county'] },
      [T(1, 'research Iowa county boards')]).adopt !== null,
      'control: the same shape WITH the real anchor does adopt');
  }

  // ── duplicate collapse — the 7-phrasings-of-one-request case ─────────────────────────────────
  {
    const threads = [
      T(1, 'compile leadership and historical data for all Louisiana parishes', { mention_count: 5 }),
      T(2, 'complete the parish leadership work in Louisiana'),
      T(3, 'conduct research on parish leadership for Lucas in Louisiana'),
      T(4, 'monitor the Norway vs England world cup match for Lucas'),
    ];
    const m = ot.matchCarriedThread(LA, threads);
    ok(m.adopt && m.adopt.id === 1, 'adopts the thread she has actually engaged with (mention_count)');
    ok(m.duplicates.length === 2, 'the other phrasings come back as duplicates');
    ok(!m.duplicates.some(d => d.id === 4), 'SAFETY: the unrelated thread is NOT swept up as a duplicate');
  }

  // ── honest carrying: the prompt block must not assert stale threads as in-progress ───────────
  {
    const fresh = Date.now();
    const old = fresh - 8 * 86400000;
    const block = ot.formatTopBlock([
      { id: 7, content: 'monitor the Norway vs England world cup match', status: 'pending', last_touched_ts: old },
      { id: 8, content: 'draft the parish brief', status: 'pending', last_touched_ts: fresh },
    ], { now: fresh });
    ok(/NOT TOUCHED IN 8d/.test(block), 'stale thread is labelled with its age');
    ok(/carried, not in progress/.test(block), 'stale thread is explicitly not claimed as in progress');
    ok(!/\[NOT TOUCHED[^\]]*\]\s*$/m.test(block.split('\n').find(l => /draft the parish brief/.test(l)) || ''),
      'fresh thread carries no stale label');
    ok(!/WHAT YOU ARE WORKING ON/.test(block), 'header no longer asserts all carried threads as active work');
    ok(ot.formatTopBlock([]) === '', 'empty → empty block');
    // seconds-precision timestamps are stored in places; both must read as the same age
    const secs = ot.formatTopBlock([{ id: 9, content: 'x', status: 'pending', last_touched_ts: Math.floor(old / 1000) }], { now: fresh });
    ok(/NOT TOUCHED IN 8d/.test(secs), 'handles second-precision last_touched_ts');
  }

  // ── freshest(): the anti-fixation redirect must not point at the stalest thread ──────────────
  {
    const now = Date.now();
    const list = [
      { id: 1, content: 'world cup match', last_touched_ts: now - 8 * 86400000 },
      { id: 2, content: 'the live parish work', last_touched_ts: now - 60000 },
    ];
    ok(ot.freshest(list).id === 2, 'freshest picks the most recently touched, not [0]');
    ok(ot.freshest([]) === null && ot.freshest(null) === null, 'freshest: empty/bad → null');
  }

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
