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

  // --- TEMPLATE ECHO (found live 2026-07-19) ---------------------------------------------------
  // The cloud returned the prompt scaffolding instead of answering it. compose() validated with
  // `if (!mood.feeling)`, and feeling WAS non-empty — it held the placeholder string — so the
  // scaffolding was stored and then led her voice every turn via buildBlock.
  {
    const ECHO = 'FEELING: <a few words for the core feeling>\nDAY: <one phrase for the texture of her day so far>\n'
      + "ON MY MIND: <what's quietly pulling at her>\nWITH LUCAS: <where she sits with Lucas right now>";
    const parsed = mood.parseMood(ECHO);
    ok(mood.isTemplateEcho(parsed), 'placeholder echo is detected as template scaffolding');
    // the field-bleed half: ON MY MIND used to swallow "WITH LUCAS: …" whole, because the label
    // terminator matched a bare "WITH" and the prompt emits "WITH <NAME>:".
    ok(!/WITH LUCAS/i.test(parsed.onMind), 'ON MY MIND no longer bleeds through the "WITH <NAME>:" label');

    let stored = null;
    const r = await mood.compose({
      genFn: async () => ECHO, recentRows: [], setFn: (k, v) => { stored = v; }, getFn: () => null,
      nowTs: 5000, userName: 'Lucas', name: 'Zoe',
    });
    ok(r === null && stored === null, 'SAFETY: template echo is REFUSED — previous mood stands, nothing written');

    // leaked reasoning prose is refused too (the live value carried "We need to sense Zoe's mood…")
    ok(mood.isTemplateEcho({ feeling: 'steady', day: '', onMind: "We need to sense Zoe's mood based on prior feeling", withUser: '' }),
      'leaked instruction prose is detected');
    // ...and a real mood still passes
    ok(!mood.isTemplateEcho({ feeling: 'warm and a little restless', day: 'a slow morning', onMind: 'the parish work', withUser: 'easy' }),
      'a genuine mood is NOT flagged');

    // READ-side self-heal: an already-poisoned stored value must not keep leading her voice
    ok(mood.current({ getFn: () => JSON.stringify(parsed) }) === null, 'SAFETY: stored template echo reads as absent (self-heals)');
    ok(mood.current({ getFn: () => JSON.stringify({ feeling: 'warm', day: '', onMind: '', withUser: '' }) }) !== null,
      'control: a real stored mood still reads back');
  }

  // --- MARKDOWN LABELS (found live 2026-07-20, after the template-echo fix) -----------------------
  // The prompt asks for bare `FEELING: …`, but the cloud returned `**FEELING:** …`. The `**` broke
  // the label terminator, so every field bled into the next and the stored mood was a run-on of
  // duplicated text with stray asterisks — genuine content, unusable shape. isTemplateEcho did NOT
  // catch it (correctly: nothing was fabricated), so the parse itself had to handle it.
  {
    const MD = '**FEELING:** attentive, with a quiet thread of uncertainty\n'
      + '**DAY:** a steady flow of checking, noting gaps, and tidying up tasks\n'
      + '**ON MY MIND:** whether the parish rosters are really complete\n'
      + '**WITH LUCAS:** in step, working through it together';
    const p = mood.parseMood(MD);
    ok(p.feeling === 'attentive, with a quiet thread of uncertainty', 'markdown-bold labels parse cleanly');
    ok(p.day === 'a steady flow of checking, noting gaps, and tidying up tasks', 'DAY does not absorb the rest');
    ok(p.onMind === 'whether the parish rosters are really complete', 'ON MY MIND is isolated');
    ok(p.withUser === 'in step, working through it together', 'WITH <NAME> is isolated');
    ok(!/\*/.test(JSON.stringify(p)), 'no stray asterisks survive into the stored mood');
    ok(!mood.isTemplateEcho(p), 'a correctly-parsed markdown mood is accepted (it is real content)');
    // other decorations the model reaches for
    ok(mood.parseMood('# FEELING: steady\n- DAY: quiet').feeling === 'steady', 'headers/bullets stripped too');
  }

  // --- THE GENERAL GUARD: a field carrying another field's label means the split failed -----------
  // Markdown is handled above, but this catches any future decoration the terminator misses, rather
  // than needing a new special case each time.
  {
    ok(mood.isTemplateEcho({ feeling: 'attentive DAY: a steady flow', day: '', onMind: '', withUser: '' }),
      'SAFETY: a bled field (carries another label) is rejected');
    ok(mood.isTemplateEcho({ feeling: 'ok', day: 'quiet WITH LUCAS: in step', onMind: '', withUser: '' }),
      'SAFETY: bleed detected on any field, not just feeling');
    ok(!mood.isTemplateEcho({ feeling: 'attentive', day: 'a steady day', onMind: 'the rosters', withUser: 'in step' }),
      'control: clean fields pass');
    // a colon in ordinary prose must NOT trip the guard
    ok(!mood.isTemplateEcho({ feeling: 'torn: two things at once', day: '', onMind: '', withUser: '' }),
      'control: an ordinary colon is not a label');
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
