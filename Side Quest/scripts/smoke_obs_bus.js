/* Smoke: lib/obs_bus — the bounded observability event bus (emit → buffered flush → poll reader).
 * Offline: temp DB, no timers relied on (flush called explicitly), no model/network.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_obs_bus.js
 */
const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_obs_${Date.now()}.db`);
require('../lib/db').init();
const obs = require('../lib/obs_bus');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

(async () => {
  // --- validation: junk never lands ---
  ok(obs.emit({}) === null, 'emit without lane/kind/text → null (nothing buffered)');
  ok(obs.emit({ lane: 'x', kind: 'line', text: '' }) === null, 'empty text → null');

  // --- live listeners fire on emit, before any flush ---
  let live = null;
  const un = obs.subscribe((e) => { live = e; });
  const e1 = obs.emit({ lane: 'subc', kind: 'line', text: '[subc] synthesis stored — tension: "x"', ref: 'thread:3632' });
  ok(live && live.text === e1.text && live.lane === 'subc', 'a subscriber sees the event immediately (live push path)');
  un();
  obs.emit({ lane: 'directed', kind: 'line', text: '[directed] #3632 → started X' });
  ok(live.lane === 'subc', 'unsubscribe works — later events do not reach the removed listener');

  // --- a throwing listener never breaks the emitter ---
  const un2 = obs.subscribe(() => { throw new Error('bad listener'); });
  const e2 = obs.emit({ lane: 'watch', kind: 'status', text: 'watched 12 line(s)', data: { observed: 12 } });
  ok(e2 && e2.lane === 'watch', 'a throwing listener is contained (emit still returns the event)');
  un2();

  // --- buffered flush → poll reader with tail semantics ---
  const n = obs.flush();
  ok(n >= 3, `flush writes the batch in one transaction (${n} rows)`);
  const all = obs.recent({ sinceId: 0, limit: 100 });
  ok(all.length >= 3 && all[0].id < all[all.length - 1].id, 'recent() returns ascending ids (tail poll contract)');
  const lastId = all[all.length - 1].id;
  ok(obs.recent({ sinceId: lastId }).length === 0, 'sinceId=last → empty (nothing new)');
  obs.emit({ lane: 'rehearsal', kind: 'result', text: 'sandbox test PASS', data: { pass: true } });
  obs.flush();
  const tail = obs.recent({ sinceId: lastId });
  ok(tail.length === 1 && tail[0].kind === 'result' && tail[0].data && tail[0].data.pass === true, 'incremental poll sees exactly the new event, data JSON round-trips');

  // --- lane filter ---
  const subcOnly = obs.recent({ sinceId: 0, lanes: ['subc'] });
  ok(subcOnly.length >= 1 && subcOnly.every((r) => r.lane === 'subc'), 'lane filter narrows the read');

  // --- text clamp ---
  obs.emit({ lane: 'x', kind: 'line', text: 'y'.repeat(2000) });
  obs.flush();
  const clamped = obs.recent({ sinceId: 0, lanes: ['x'] });
  ok(clamped.length === 1 && clamped[0].text.length <= 500, 'oversized text is clamped, never stored raw');

  // --- age prune: an ancient event falls out ---
  obs.emit({ lane: 'old', kind: 'line', text: 'ancient event' }, { nowMs: Date.now() - 8 * 24 * 3600e3 });
  obs.flush();
  ok(obs.recent({ sinceId: 0, lanes: ['old'] }).length === 1, 'the ancient event landed');
  obs.prune();
  ok(obs.recent({ sinceId: 0, lanes: ['old'] }).length === 0, 'prune removes events past MAX_AGE (bounded store — the route_obs lesson)');

  obs._stop();
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  try { require('../lib/db').getDb().close(); } catch {}
  try { require('fs').unlinkSync(process.env.SQ_DB_PATH); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
