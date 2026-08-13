/**
 * Wiring smoke — the FIRST smoke that loads the real main.js (via scripts/lib/main_harness).
 * The review's core finding: zero smokes loaded main.js, and every recent live incident was
 * a main.js seam bug. This suite asserts the REGISTRATION SURFACE: module scope loads clean,
 * every critical IPC seam is wired, no channel is double-registered (the harness stub throws
 * exactly like live electron would), the crash handlers are installed, and the app lifecycle
 * chain is attached. It does NOT release whenReady — no boot loops, no model calls.
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\smoke_main_wiring.js
 */
const path = require('path');
const os = require('os');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_mainwire_${Date.now()}.db`);

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

// Baseline BEFORE main.js installs its crash handlers, so the assert measures main.js's own.
const baseRejection = process.listeners('unhandledRejection').length;
const baseUncaught = process.listeners('uncaughtException').length;

let h = null, loadErr = null;
try {
  h = require('./lib/main_harness').load();
} catch (e) {
  loadErr = e;
}
ok('main.js module scope loads under the harness (no throw, no dup registration)', !!h && !loadErr);
if (loadErr) {
  console.log(`      load error: ${loadErr.message}`);
  console.log(`\nFAILURES — ${pass} passed, ${fail} failed`);
  process.exit(1);
}

// --- registration surface ---
const total = h.handlers.size + h.listeners.size;
ok(`registration floor holds (${total} channels ≥ 100 — mass deregistration would trip this)`, total >= 100);

// The seams behind live incidents + one per major surface. A missing name here means a
// renderer door went dark — exactly the class of break no lib smoke can see.
const CRITICAL_HANDLE = [
  'chat:send',            // THE seam: operator gate, reply contract, tier stamping all live inside
  'voice:speak',          // two-way voice output door
  'stt:transcribe',       // two-way voice input door
  'meet:join',            // meeting lane entry
  'canvas:get-all',       // canvas surface
  'kg:overview',          // knowledge-graph surface
  'editor:list-documents',// editor studio
  'creator:list',         // creator surface
  'crm:search',           // CRM surface
  'leg:search',           // legislation surface
  'poll:list',            // polling surface
  'calendar:events',      // calendar surface
  'feeds:list',           // monitors widget
  'news:briefing',        // data-stream lane
  'reader:list',          // reader/library surface
  'obs:recent',           // self-watch bus poll door
  'dashboard:metrics',    // dashboard
  'meta:get',             // meta store door
  'monologue:recent',     // subconscious surface
  'open_threads:recent',  // threads surface
  'browser:status',       // browser lane door
  'usage:summary',        // quota/usage surface
  'puller:list-targets',  // puller suite (registered via pullerIpc.register)
];
for (const ch of CRITICAL_HANDLE) ok(`handle wired: ${ch}`, h.handlers.has(ch));

const CRITICAL_ON = ['voice:play-done', 'voice:barge']; // streaming-speech serialization seams
for (const ch of CRITICAL_ON) ok(`listener wired: ${ch}`, h.listeners.has(ch) && h.listeners.get(ch).length > 0);

// --- lifecycle + crash safety ---
ok('app.whenReady() chain attached (exactly one boot chain)', h.whenReadyCalls === 1);
for (const evt of ['window-all-closed', 'render-process-gone', 'child-process-gone']) {
  ok(`app lifecycle handler: ${evt}`, h.appEvents.has(evt) && h.appEvents.get(evt).length > 0);
}
ok('crash handler installed: unhandledRejection', process.listeners('unhandledRejection').length > baseRejection);
ok('crash handler installed: uncaughtException', process.listeners('uncaughtException').length > baseUncaught);

// --- a real seam invocation (no model, no network): meta:get round-trips the stub event ---
// db.init() normally runs inside the held whenReady chain; init the temp DB here the same
// way every lib smoke does (same module instance via the require cache).
(async () => {
  require('../lib/db').init();
  let invoked = null, threw = null;
  try { invoked = await h.invoke('meta:get', 'harness_probe_key_that_does_not_exist'); } catch (e) { threw = e.message; }
  ok('a handler is INVOKABLE through the harness (meta:get round-trips on the temp DB)', threw === null && (invoked === null || invoked === undefined));
  if (threw) console.log(`      invoke error: ${threw}`);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { require('fs').unlinkSync(process.env.SQ_DB_PATH); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
