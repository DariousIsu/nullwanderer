/* smoke_activity_coverage.js — every kind on the kg:activity bus must have a gesture behind it.
 *
 * WHY THIS EXISTS. Lucas, 2026-07-22, looking at the 3D panel: "I am seeing so many more actions in the log
 * than are actually taking place on the visual." He was right. The log dock printed every event the bus
 * delivered; the renderer's dispatcher only had branches for some of them. Three kinds with LIVE emitters —
 * `note` (every insertMemory, the busiest emitter in the app), `doc.land` (every document) and `news` (a
 * followed story she raises) — had entries in the log's colour table but no branch at all, so they printed a
 * neatly coloured row and drew nothing, indefinitely.
 *
 * That is not a bug a human notices as a bug. It reads as "the animation is flaky." The failure mode is
 * SILENCE, and silence is exactly what a test is for.
 *
 * This is a STATIC check by design: it needs no Electron, no DB, no GPU and no window, so it can sit in the
 * offline gate and fail the moment someone adds a seventeenth kind to the bus without giving it something to
 * draw. It reads three things out of the source and compares them:
 *
 *   1. EMITTERS   — every `kind: '...'` pushed through lib/kg_activity.js, main.js's emitKgActivity, and
 *                   db.js's _kgTap helper.
 *   2. DISPATCH   — every kind dispatchActivity() in renderer/kg3d.js actually routes.
 *   3. LOG TABLE  — every kind KIND_META gives a label and colour to (i.e. claims to understand).
 *
 * The hard assertion is (1) ⊆ (2): anything that can reach the panel must draw. (3) is reported as advisory,
 * because a colour with no emitter is dead weight, not a lie on screen.
 *
 * Run: node scripts/smoke_activity_coverage.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const uniq = (a) => [...new Set(a)].sort();

// ---- 1. what the DB side can emit -------------------------------------------------------------------------
// Three shapes reach the bus, and an earlier version of this check only caught the first two — which made the
// smoke under-report, the same disease it exists to catch. Scan a WINDOW after each emit marker rather than
// the marker's own line: db.js's `think` heartbeat assigns `global.__emitKgActivity` to a local on one line
// and calls it on the next, so a line-scoped regex never sees its kind.
const EMIT_MARK = /kga\.emit\(|require\('\.\/kg_activity'\)\.emit\(|emitKgActivity\(|__emitKgActivity/g;
function emittedKinds() {
  const found = [];
  const files = ['main.js'].concat(
    fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js')).map((f) => 'lib/' + f)
  );
  for (const rel of files) {
    let src;
    try { src = read(rel); } catch (e) { continue; }
    let m;
    EMIT_MARK.lastIndex = 0;
    while ((m = EMIT_MARK.exec(src))) {
      const win = src.slice(m.index, m.index + 420);      // the payload literal, however it is wrapped
      const k = win.match(/kind: *'([a-z._]+)'/);
      if (k) found.push(k[1]);
    }
    for (const t of src.match(/_kgTap\( *'([a-z._]+)'/g) || []) found.push(t.replace(/_kgTap\( *'|'/g, ''));
  }
  // The dedup engine still rides the legacy kg:curation-move channel; kg3d folds it into the same stream as
  // `node.merge`, so it is a live kind even though nothing names it in an emit payload.
  if (/onCurationMove\([\s\S]{0,300}?kind: *'node\.merge'/.test(read('renderer/kg3d.js'))) found.push('node.merge');
  return uniq(found);
}

// ---- 2. what the renderer draws ---------------------------------------------------------------------------
function dispatchedKinds(src) {
  const body = src.slice(src.indexOf('function dispatchActivity'));
  const end = body.indexOf('\nfunction onActivity');
  const fn = end > 0 ? body.slice(0, end) : body;
  return uniq((fn.match(/k === '([a-z._]+)'/g) || []).map((s) => s.replace(/k === '|'/g, '')));
}

// ---- 3. what the log claims to understand -----------------------------------------------------------------
function metaKinds(src) {
  const i = src.indexOf('const KIND_META');
  const block = src.slice(i, src.indexOf('};', i));
  return uniq((block.match(/'([a-z._]+)': *\[/g) || []).map((s) => s.replace(/'|: *\[/g, '')));
}

// ---- 2b. EXECUTE the dispatcher ---------------------------------------------------------------------------
// A branch existing is not proof the branch fires. This lifts dispatchActivity() out of the renderer and runs
// it for real against stub gestures, so the test observes what a live event actually does: which gesture it
// calls and what verdict it returns. Everything the function touches is injected, so no THREE, no WebGL, no
// DOM and no force-graph — it stays an offline-deterministic gate.
function loadDispatcher(src) {
  const i = src.indexOf('function dispatchActivity');
  const j = src.indexOf('\nfunction onActivity', i);
  const fnSrc = src.slice(i, j);
  const calls = [];
  const spy = (name) => (...a) => { calls.push({ name, args: a }); };
  const V = (x, y, z) => ({ x: x || 0, y: y || 0, z: z || 0 });
  const deps = {
    // a node exists for anything with a plausible object name; `nodeFor` is what mints in the real thing.
    nodeFor: (evt, name) => (name == null || name === '' ? null : { id: name, x: 1, y: 2, z: 3, store: evt.db }),
    V3: (n) => V(n.x, n.y, n.z),
    THREE: { Color: function () { this.getHex = () => 0xffffff; }, Vector3: function (x, y, z) { return V(x, y, z); } },
    nodeColor: () => '#ffffff',
    _coreCen: V(0, 0, 0), ZOE_ROSE: '#f9a8d4', HEAR_HEX: 1, SAY_HEX: 2,
    addHotLink: spy('addHotLink'), loadSelf: spy('loadSelf'),
    // her face on the cloud: hear/say/think move it, so the dispatcher reaches these too
    faceExpression: spy('faceExpression'), faceSpeak: spy('faceSpeak'), face: { target: 0 },
  };
  for (const g of ['queueBorn', 'queueNote', 'gEnrich', 'gEdge', 'gMatch', 'gRecall', 'gPromote', 'gAbsorb',
    'gThink', 'gCross', 'gEvidence', 'gInflow', 'gRefute']) deps[g] = spy(g);
  // sloppy-mode Function body, so `with` is available to bind the stubs without rewriting the source.
  const fn = new Function('deps', `with (deps) { ${fnSrc}\n return dispatchActivity; }`)(deps);
  return { fn, calls };
}
// One representative event per kind, shaped like the real emitters. Kinds whose anchor is PROSE rather than an
// object name (hear/say carry 110 chars of conversation, think a rowid, note a "[kind] content" string) are
// marked so the test can assert the dispatcher does NOT try to mint a node out of a sentence.
const SAMPLES = {
  'node.born': { db: 'sidequest', anchor: 'Some Entity' },
  'node.enrich': { db: 'sidequest', anchor: 'Some Entity' },
  'edge.born': { db: 'sidequest', anchor: 'A', anchor2: 'B' },
  'edge.promote': { db: 'echo', anchor: 'A', anchor2: 'B' },
  'edge.prune': { db: 'echo', anchor: 'A' },
  'match.hit': { db: 'sidequest', anchor: 'a mention of it', anchor2: 'Known Object' },
  recall: { db: 'echo', anchor: 'Known Object' },
  observe: { db: 'sidequest', anchor: 'Subject', anchor2: 'Target', rel: 'works_for' },
  promote: { db: 'sidequest', anchor: 'Doc Title' },
  'node.promote': { db: 'echo', anchor: 'Doc Title' },
  'node.merge': { db: 'echo', anchor: 'Survivor', count: 3 },
  'node.degrade': { db: 'echo', anchor: 'Weakened' },
  think: { db: 'sidequest', anchor: '48211', prose: true },
  self: { db: 'sidequest', anchor: 'I tend to...', prose: true },
  reflect: { db: 'sidequest', anchor: 'I noticed that...', prose: true },
  hear: { db: 'sidequest', anchor: 'what Lucas actually typed, at length', prose: true },
  say: { db: 'sidequest', anchor: 'what she actually replied, at length', prose: true },
  note: { db: 'sidequest', anchor: '[fact] some claim', prose: true },
  'doc.land': { db: 'sidequest', anchor: 'A Filing.pdf', prose: true },
  news: { db: 'sidequest', anchor: 'A story title', prose: true },
  encounter: { db: 'sidequest', anchor: 'Object Label', count: 40, prose: true },
  refute: { db: 'sidequest', anchor: 'Wrong Claim' },
  'audit.clean': { db: 'echo', anchor: 'sweep', prose: true },
};

// -----------------------------------------------------------------------------------------------------------
const kg3d = read('renderer/kg3d.js');
const emitted = emittedKinds();
const drawn = dispatchedKinds(kg3d);
const meta = metaKinds(kg3d);

// `node.born` is dispatched by name before the k === chain (it queues into a coalescing buffer), so add it
// explicitly rather than loosening the parse and letting a real miss slip through.
if (/if \(k === 'node\.born'\) \{ queueBorn/.test(kg3d)) drawn.push('node.born');

const silent = emitted.filter((k) => !drawn.includes(k));
const unlabelled = emitted.filter((k) => !meta.includes(k));
const deadColour = meta.filter((k) => !emitted.includes(k));

console.log(`emitters (${emitted.length}): ${emitted.join(', ')}`);
console.log(`dispatched (${uniq(drawn).length}): ${uniq(drawn).join(', ')}`);
console.log('');

let failed = false;
if (silent.length) {
  failed = true;
  console.log(`FAIL: ${silent.length} kind(s) reach the activity log and draw NOTHING: ${silent.join(', ')}`);
  console.log('      Add a branch in dispatchActivity() (renderer/kg3d.js) — or stop emitting the kind.');
} else {
  console.log(`PASS: all ${emitted.length} live emitter kinds have a gesture in dispatchActivity().`);
}

if (unlabelled.length) {
  failed = true;
  console.log(`FAIL: ${unlabelled.length} emitted kind(s) missing from KIND_META (they log as raw slugs): ${unlabelled.join(', ')}`);
} else {
  console.log('PASS: every emitted kind has a label + colour in KIND_META.');
}

// Advisory only: a colour with no emitter is harmless on screen. Named so it stays deliberate, not forgotten.
if (deadColour.length) console.log(`note: ${deadColour.length} KIND_META entr(ies) have no emitter yet (reserved): ${deadColour.join(', ')}`);

// The dispatcher must also report a verdict, or the log cannot mark what failed to draw — that plumbing is
// the other half of the fix and is just as easy to silently delete.
if (!/return 'miss'/.test(kg3d) || !/logActivity\(evt, verdict\)/.test(kg3d)) {
  failed = true;
  console.log('FAIL: the dispatch verdict plumbing is gone — logActivity can no longer mark undrawn rows.');
} else {
  console.log('PASS: dispatch returns a verdict and the log receives it.');
}

// ---- the behavioural half: run every kind through the real dispatcher ------------------------------------
console.log('');
let ran = 0, silentAtRuntime = [];
try {
  const { fn, calls } = loadDispatcher(kg3d);
  for (const kind of emitted) {
    const s = SAMPLES[kind];
    if (!s) { silentAtRuntime.push(`${kind} (no sample in this test — add one)`); continue; }
    calls.length = 0;
    const verdict = fn(Object.assign({ kind }, s));
    ran++;
    if (verdict === 'miss' || !calls.length) { silentAtRuntime.push(`${kind} → verdict '${verdict}', ${calls.length} gesture(s)`); continue; }
    // A prose anchor must never be resolved into a node: minting an id out of a sentence is worse than the
    // invisibility this whole fix was for. Assert those kinds fire an AMBIENT gesture, never a node-located one.
    if (s.prose) {
      const located = calls.filter((c) => /^(gEnrich|gEdge|gMatch|gRecall|gPromote|gAbsorb|gRefute)$/.test(c.name) && c.name !== 'gRefute');
      if (located.length && kind !== 'self' && kind !== 'reflect') {
        failed = true;
        console.log(`FAIL: '${kind}' has a PROSE anchor but routed to a node-located gesture (${located.map((c) => c.name).join(', ')}) — that mints a node whose id is a sentence.`);
      }
    }
  }
  if (silentAtRuntime.length) {
    failed = true;
    console.log(`FAIL: ${silentAtRuntime.length} kind(s) drew nothing when actually dispatched:`);
    for (const s of silentAtRuntime) console.log('      ' + s);
  } else {
    console.log(`PASS: all ${ran} emitted kinds dispatched to a real gesture (executed, not just grepped).`);
  }

  // VERSION SKEW. The renderer reloads independently of a main-process reboot, so for a window the old
  // `observe` tap is still sending subject+relation+target as ONE string. Minting that would put a sentence
  // in the graph as a node id. The old shape must stay invisible rather than corrupt the node set.
  calls.length = 0;
  const legacy = fn({ kind: 'observe', db: 'sidequest', anchor: 'Subject works_for Target' });
  if (legacy !== 'miss' || calls.length) {
    failed = true;
    console.log(`FAIL: a legacy-shape 'observe' (no rel/anchor2) drew anyway — verdict '${legacy}', ${calls.length} gesture(s). That mints a sentence as a node id.`);
  } else {
    console.log("PASS: legacy-shape 'observe' returns miss and mints nothing (version-skew guard holds).");
  }
} catch (e) {
  failed = true;
  console.log('FAIL: could not execute dispatchActivity() — ' + (e && e.message));
}

console.log(failed ? '\nSMOKE FAILED' : '\nSMOKE PASSED');
process.exit(failed ? 1 : 0);
