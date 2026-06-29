/* Smoke: lib/reawaken — continuity across resets (self-awareness Layer 5).
 * Deterministic: turns/threads/clock/store all injected, no db.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_reawaken.js
 */
const rw = require('../lib/reawaken');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const turns = [
  { speaker: 'user', content: 'can you keep researching 6G privacy implications for me' },
  { speaker: 'ai_said', content: "Absolutely — I'll dig into 6G privacy and the lunar quantum-entanglement angle." },
  { speaker: 'ai_thought', content: 'internal only — should not surface' }
];
const threads = [{ content: 'research 6G communications + privacy' }, { content: 'support Lucas with cheerleading scoring' }];

// --- composeBridge: builds + stores a bridge from real prior-session data ---
const store = {};
const setFn = (k, v) => { store[k] = v; };
const text = rw.composeBridge({ recentTurns: turns, threads, gapMs: 3 * 60 * 60 * 1000, userName: 'Lucas', now: 5000, setFn });
ok(text && /continuing a life already in progress/i.test(text), 'bridge frames a continuous self, not a fresh start');
ok(/about 3 hours since you and Lucas last spoke/i.test(text), 'includes the offline gap');
ok(/Lucas was saying: "can you keep researching 6G privacy/.test(text), "quotes Lucas's last message");
ok(/your own last words were: "Absolutely/i.test(text), 'quotes her own last words');
ok(/still carrying: research 6G communications/i.test(text), 'lists carried threads');
ok(!/internal only/.test(text), 'never surfaces ai_thought content');
ok(/don'?t reintroduce yourself/i.test(text), 'tells her not to act fresh');
ok(store[rw.BRIDGE_KEY] === text && store[rw.BRIDGE_AT_KEY] === '5000', 'stores bridge + timestamp');

// --- genuine first run (no prior turns) → no bridge ---
ok(rw.composeBridge({ recentTurns: [], threads, now: 1, setFn: () => { throw new Error('should not store'); } }) === null,
  'no prior conversation → no bridge, no store');

// --- awarenessLine: shown within the window, gone after ---
const getFn = (k) => ({ [rw.BRIDGE_KEY]: 'bridge text', [rw.BRIDGE_AT_KEY]: '1000' }[k]);
ok(rw.awarenessLine({ getFn, now: 1000 + 60 * 1000 }) === 'bridge text', 'within window → surfaced');
ok(rw.awarenessLine({ getFn, now: 1000 + rw.WINDOW_MS + 1 }) === null, 'past window → faded out');
ok(rw.awarenessLine({ getFn: () => null, now: 9999 }) === null, 'no bridge stored → null');

// --- gap omitted gracefully when unknown ---
const noGap = rw.composeBridge({ recentTurns: turns, threads: [], gapMs: null, now: 2, setFn });
ok(!/since you and/.test(noGap) && /continuing a life/.test(noGap), 'unknown gap → omits the gap line, still bridges');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
