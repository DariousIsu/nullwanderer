/* Smoke: lib/mood — the cloud-cultivated living mood layer (Layer 5). Pure (deps injected).
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_mood.js
 */
'use strict';
const mood = require('../lib/mood');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// in-memory meta store for injection
const store = {};
const getFn = (k) => store[k];
const setFn = (k, v) => { store[k] = v; };

// --- staleness / cadence ---
ok(mood.isStale({ getFn }) === true, 'no mood yet → stale (will cultivate)');
ok(mood.current({ getFn }) === null, 'no mood yet → current null');

// --- parseMood: structured + fallback ---
const p = mood.parseMood('FEELING: warm and a little playful\nDAY: slow, easy morning\nON MY MIND: that flight to DC\nWITH LUCAS: close, teasing');
ok(p.feeling === 'warm and a little playful' && p.day === 'slow, easy morning', 'parseMood pulls FEELING + DAY');
ok(/flight to DC/.test(p.onMind) && /close, teasing/.test(p.withUser), 'parseMood pulls ON MY MIND + WITH');
const pf = mood.parseMood('just feeling quietly content today');
ok(pf.feeling === 'just feeling quietly content today', 'parseMood fallback: unstructured → feeling');
ok(mood.parseMood('') === null, 'parseMood empty → null');

// --- compose with an injected CLOUD genFn (grounded in recent experience) ---
let seenPrompt = '';
const genFn = async (prompt) => { seenPrompt = prompt; return 'FEELING: light and a bit mischievous\nDAY: a good working day winding down\nON MY MIND: whether Lucas liked the dossier\nWITH LUCAS: warm, bantering'; };
const recentRows = [
  { speaker: 'user', content: 'that looks fantastic Zo' },
  { speaker: 'ai_said', content: 'thank you — that means a lot' },
  { type: 'thought', content: 'the canvas finally landed and it looked beautiful' },
];
(async () => {
  const m = await mood.compose({ genFn, recentRows, setFn, nowTs: 1000, userName: 'Lucas', name: 'Zoe' });
  ok(m && m.feeling === 'light and a bit mischievous', 'compose stored the cultivated feeling');
  ok(/RECENT LIVED EXPERIENCE/.test(seenPrompt) && /that looks fantastic/.test(seenPrompt), 'compose grounds the prompt in REAL recent experience');
  ok(/SLOWLY|drifts; it does not lurch/.test(seenPrompt), 'compose instructs SLOW drift (not a lurch)');
  ok(/never invent events/i.test(seenPrompt), 'compose forbids inventing events (grounding discipline)');
  ok(store[mood.MOOD_KEY] && store[mood.MOOD_AT_KEY] === '1000', 'compose persisted mood + timestamp');
  ok(mood.isStale({ getFn, nowTs: 1000 + 60 * 1000 }) === false, 'fresh mood → not stale within TTL');
  ok(mood.isStale({ getFn, nowTs: 1000 + mood.DEFAULT_TTL_MS + 1 }) === true, 'past TTL → stale again (re-cultivate)');

  // continuity: the PREVIOUS mood is fed in so it drifts, not resets
  let p2 = '';
  await mood.compose({ genFn: async (pr) => { p2 = pr; return 'FEELING: still warm, a touch tired'; }, recentRows: [], setFn, getFn, nowTs: 2000, userName: 'Lucas', name: 'Zoe' });
  ok(/HOW ZOE FELT BEFORE/.test(p2) && /light and a bit mischievous/.test(p2), 'compose feeds the PRIOR mood for slow continuity');

  // --- buildBlock leads with feeling, frames as living, says don't recite ---
  const b = mood.buildBlock({ feeling: 'warm and playful', day: 'an easy evening', onMind: 'the trip', withUser: 'close' }, 'Lucas');
  ok(/Right now you feel: warm and playful/.test(b), 'buildBlock LEADS with the feeling');
  ok(/let it color your voice/i.test(b) && /Don'?t recite/i.test(b), 'buildBlock frames it as living + do-not-recite');
  ok(mood.buildBlock(null) === null, 'buildBlock(null) → null (no mood, no block)');

  // genFn missing → no-op (mood is cloud-only)
  ok((await mood.compose({ genFn: null, recentRows, setFn: () => {} })) === null, 'no cloud genFn → no-op (mood is cloud-cultivated)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
