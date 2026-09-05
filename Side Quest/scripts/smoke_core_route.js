'use strict';
/**
 * smoke_core_route — the core under the idle lane (lib/core_route.js): config precedence and the kill, the pure
 * routing decision, readiness with the VRAM bar, serving with a refit to the core's window and keep_alive -1,
 * the escalation, the sampled shadow that never blocks, and the warm. Fakes for the daemon, the fitter, the
 * counter and the record; no network, no store, no model.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_core_route.js
 */
const R = require('../lib/core_route');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log(`  ok   ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } }
const metaOf = (obj) => (k) => (k in obj ? obj[k] : null);

console.log('smoke_core_route');

// ── config ──
let c = R.config({ getMeta: metaOf({}), env: {} });
ok(!c.on && c.model === '' && c.numCtx === 8192 && c.keepAlive === -1 && c.firstLanes.size === 0 && c.shadowRate === 0, 'defaults: off, no model, 8k, resident, no first lanes, no shadow');
c = R.config({ getMeta: metaOf({ 'core.on': '1', 'core.model': 'qwen3.5:4b', 'core.num_ctx': '16384', 'core.first_lanes': 'idle, consciousness', 'core.shadow_rate': '0.25', 'core.vram_bar_gb': '18' }), env: {} });
ok(c.on && c.model === 'qwen3.5:4b' && c.numCtx === 16384 && c.firstLanes.has('idle') && c.firstLanes.has('consciousness') && c.shadowRate === 0.25 && c.vramBarGb === 18, 'meta drives every field');
c = R.config({ getMeta: metaOf({ 'core.on': '1', 'core.model': 'qwen3.5:4b' }), env: { ZOE_CORE: '0' } });
ok(!c.on && c.killed, 'ZOE_CORE=0 kills over meta');
c = R.config({ getMeta: metaOf({}), env: { ZOE_CORE: '1', ZOE_CORE_MODEL: 'gemma4:e2b-it-qat', ZOE_CORE_KEEP_ALIVE: '30m' } });
ok(c.on && c.model === 'gemma4:e2b-it-qat' && c.keepAlive === '30m', 'env fills when meta is silent; a duration keep_alive is kept as a string');
c = R.config({ getMeta: () => { throw new Error('no db'); }, env: {} });
ok(!c.on, 'a store that throws yields the default, never an exception');

// ── decide ──
const on = { on: true, model: 'm', firstLanes: new Set(['consciousness']), killed: false };
ok(R.decide({ cfg: { on: false, killed: false }, lane: 'idle', cloud: true, ready: true }).route === 'legacy', 'off → legacy');
ok(R.decide({ cfg: { on: false, killed: true }, lane: 'idle', cloud: true, ready: true }).why === 'killed', 'killed is named');
ok(R.decide({ cfg: { ...on, model: '' }, lane: 'idle', cloud: true, ready: true }).why === 'no_model', 'no model → legacy');
ok(R.decide({ cfg: on, lane: 'idle', cloud: true, ready: false }).why === 'not_ready', 'not ready → legacy');
let d = R.decide({ cfg: on, lane: 'consciousness', cloud: true, ready: true });
ok(d.route === 'core' && d.why === 'first', 'a first lane goes to the core even with a cloud');
d = R.decide({ cfg: on, lane: 'idle', cloud: true, ready: true });
ok(d.route === 'cloud_then_core' && d.why === 'cloud_first', 'an ordinary lane: cloud first, the core behind it');
d = R.decide({ cfg: on, lane: 'idle', cloud: false, ready: true });
ok(d.route === 'core' && d.why === 'no_cloud', 'no cloud source → the core serves');

// ── needed / ready ──
ok(Math.abs(R.neededGb(3.4e9, 8192) - (3.4 + 8192 * R.KV_BYTES_PER_TOKEN / 1e9 + 0.5)) < 1e-9, 'needed GB = weights + cache for the window + headroom');
const cfgR = { on: true, model: 'qwen3.5:4b', numCtx: 8192, vramBarGb: 19 };
const tags = { models: [{ name: 'qwen3.5:4b', size: 3.4e9 }, { name: 'gemma4:12b-it-q4_K_M', size: 8.1e9 }] };
const fetchTags = async (url) => (/api\/ps/.test(url) ? { models: [] } : tags);
(async () => {
  R.resetCaches();
  let logs = [];
  ok(await R.ready(cfgR, { fetchJson: fetchTags, vram: async () => 7.6, now: 1000, log: (l) => logs.push(l) }) === true, 'pulled + room under the bar → ready');
  R.resetCaches();
  ok(await R.ready(cfgR, { fetchJson: fetchTags, vram: async () => 16.0, now: 2000, log: (l) => logs.push(l) }) === false && /VRAM 16.0 GB used/.test(logs.at(-1)), 'over the bar → not ready, the reason logged');
  R.resetCaches();
  ok(await R.ready(cfgR, { fetchJson: fetchTags, vram: async () => null, now: 3000, log: () => {} }) === true, 'an unreadable counter cannot bind the bar');
  R.resetCaches();
  ok(await R.ready({ ...cfgR, model: 'nope:1b' }, { fetchJson: fetchTags, vram: async () => 1, now: 4000, log: (l) => logs.push(l) }) === false && /not pulled/.test(logs.at(-1)), 'a model that is not pulled is not ready');
  R.resetCaches();
  const loadedPs = async (url) => (/api\/ps/.test(url) ? { models: [{ name: 'qwen3.5:4b' }] } : tags);
  ok(await R.ready(cfgR, { fetchJson: loadedPs, vram: async () => 20.5, now: 5000, log: () => {} }) === true, 'an already-loaded core is ready whatever the counter says (its bytes are the count)');
  R.resetCaches();
  let calls = 0;
  const counting = async (url) => { calls++; return fetchTags(url); };
  await R.ready(cfgR, { fetchJson: counting, vram: async () => 1, now: 6000, log: () => {} });
  await R.ready(cfgR, { fetchJson: counting, vram: async () => 1, now: 6000 + 30000, log: () => {} });
  ok(calls === 2, `readiness is cached for a minute (${calls} fetches for two checks)`);
  R.resetCaches();
  ok(await R.ready(cfgR, { fetchJson: async () => { throw new Error('ECONNREFUSED'); }, vram: async () => 1, now: 7000, log: () => {} }) === false, 'a daemon that is down → not ready, no throw');

  // ── serve ──
  const cfgS = { on: true, model: 'qwen3.5:4b', numCtx: 8192, keepAlive: -1, firstLanes: new Set(), shadowRate: 0 };
  const big = [{ role: 'system', content: 'S' }, ...Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(2000) })), { role: 'user', content: 'now' }];
  let seen = null; const lines = [];
  const fakeFit = (messages, { numCtx }) => ({ messages: messages.slice(0, 1).concat(messages.slice(-3)), report: { before: 80000, after: 6000, droppedTurns: 37, numCtx } });
  const fakeStream = async (o) => { seen = o; if (o.onToken) o.onToken('hel'); if (o.onToken) o.onToken('lo'); return 'hello'; };
  let tokens = '';
  const out = await R.serve({ cfg: cfgS, lane: 'idle', why: 'quota', messages: big, options: { num_predict: 200, temperature: 0.9 }, onToken: (t) => { tokens += t; } }, { streamChat: fakeStream, fitToWindow: fakeFit, appendLine: (sub, obj) => lines.push([sub, obj]), log: () => {}, now: (() => { let t = 1000; return () => (t += 250); })() });
  ok(out === 'hello' && tokens === 'hello', 'serve streams through the same contract and returns the text');
  ok(seen && seen.model === 'qwen3.5:4b' && seen.keepAlive === -1 && seen.base === R.OLLAMA_BASE && seen.options.num_ctx === 8192 && seen.options.temperature === 0.9 && seen.lane === 'idle', 'the core call: the core model, resident, local base, the core window, the caller\'s sampling, the lane');
  ok(seen.messages.length === 4 && lines.length === 1 && lines[0][0] === 'served' && lines[0][1].why === 'quota' && lines[0][1].refit.dropped === 37 && lines[0][1].chars === 5, 'the prompt is refit to the core window and the call is recorded with its reason');
  // failure → '' and recorded; failure on a first lane → the escalation
  const failing = async () => { throw new Error('boom'); };
  let rec = [];
  ok(await R.serve({ cfg: cfgS, lane: 'idle', why: 'no_cloud', messages: big, options: {} }, { streamChat: failing, fitToWindow: fakeFit, appendLine: (s, o) => rec.push(o), log: () => {} }) === '' && rec[0].error === 'boom', 'a failed core call is an empty answer with the error recorded, never a throw');
  let escalated = 0;
  ok(await R.serve({ cfg: cfgS, lane: 'consciousness', why: 'first', messages: big, options: {}, escalate: async () => { escalated++; return 'cloud says'; } }, { streamChat: failing, fitToWindow: fakeFit, appendLine: () => {}, log: () => {} }) === 'cloud says' && escalated === 1, 'a first lane escalates to the cloud when the core fails');
  ok(await R.serve({ cfg: cfgS, lane: 'idle', why: 'x', messages: big, options: {}, escalate: async () => { escalated++; return 'no'; } }, { streamChat: async () => '', fitToWindow: fakeFit, appendLine: () => {}, log: () => {} }) === 'no' && escalated === 2, 'an empty core answer also escalates when an escalation exists');
  ok(await R.serve({ cfg: cfgS, lane: 'idle', why: 'x', messages: big, options: {}, escalate: async () => { throw new Error('cloud down'); } }, { streamChat: async () => '', fitToWindow: fakeFit, appendLine: () => {}, log: () => {} }) === '', 'an escalation that throws is still an empty answer');

  // ── shadow ──
  const cfgSh = { ...cfgS, shadowRate: 0.5 };
  let shadowLines = []; let scheduled = [];
  const sched = (fn) => scheduled.push(fn);
  ok(R.shadow({ cfg: { ...cfgS, shadowRate: 0 }, lane: 'idle', messages: big, cloudText: 'c' }, { rng: () => 0, schedule: sched }) === false, 'rate 0 → never');
  ok(R.shadow({ cfg: cfgSh, lane: 'idle', messages: big, cloudText: 'c' }, { rng: () => 0.9, schedule: sched }) === false && scheduled.length === 0, 'the sample misses → nothing scheduled');
  ok(R.shadow({ cfg: cfgSh, lane: 'idle', messages: big, cloudText: 'the cloud said this' }, { rng: () => 0.1, schedule: sched, streamChat: async (o) => { seen = o; return 'the core said that'; }, fitToWindow: fakeFit, appendLine: (s, o) => shadowLines.push([s, o]), log: () => {} }) === true && scheduled.length === 1 && shadowLines.length === 0, 'the sample hits → scheduled, not run on the hot path');
  ok(R.shadow({ cfg: cfgSh, lane: 'idle', messages: big, cloudText: 'x' }, { rng: () => 0.1, schedule: sched }) === false, 'one shadow at a time: a second is refused while the first is pending');
  await scheduled[0]();
  ok(shadowLines.length === 1 && shadowLines[0][0] === 'shadow' && shadowLines[0][1].cloud_head === 'the cloud said this' && shadowLines[0][1].core_head === 'the core said that' && seen.lane === 'idle_shadow' && seen.maxMs === 60000 && seen.keepAlive === -1, 'the shadow records both texts, runs on its own lane with a hard budget, keeps the core resident');
  scheduled = [];
  ok(R.shadow({ cfg: cfgSh, lane: 'idle', messages: big, cloudText: 'x' }, { rng: () => 0.1, schedule: sched }) === true, 'after the first completes a new shadow may run');
  await scheduled[0]().catch(() => {});

  // ── warm ──
  let warmed = null;
  ok(await R.warm({ ...cfgS }, { streamChat: async (o) => { warmed = o; return 'ok'; }, readyFn: async () => true, log: () => {} }) === true && warmed.keepAlive === -1 && warmed.options.num_predict === 2, 'warm loads the core resident with a two-token call');
  ok(await R.warm({ ...cfgS }, { streamChat: async () => 'ok', readyFn: async () => false, log: () => {} }) === false, 'warm refuses when not ready (the bar)');
  ok(await R.warm({ ...cfgS, on: false }, { streamChat: async () => 'ok', readyFn: async () => true, log: () => {} }) === false, 'warm does nothing when off');
  ok(await R.warm({ ...cfgS }, { streamChat: async () => { throw new Error('x'); }, readyFn: async () => true, log: () => {} }) === false, 'a failed warm is false, never a throw');

  console.log(`\nsmoke_core_route: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL threw', e && e.stack || e); process.exit(1); });
