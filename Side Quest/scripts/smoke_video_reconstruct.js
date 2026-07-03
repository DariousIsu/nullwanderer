/* Smoke: lib/video_reconstruct — broadcast segment grouping + cloud reconstruction (mocked ask) + the
 * runReconstruct pass (fake store). Pure/offline. Proves fragmentary captions become one clean report per
 * segment, non-news segments drop, and it's fail-safe. Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_video_reconstruct.js */
'use strict';
const VR = require('../lib/video_reconstruct');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// ===== groupIntoSegments =====
const vids = [
  { id: 1, source_kind: 'video', source: 'CNN', sourceUrl: 'u', ts: 0, summary: 'conflict between the United' },
  { id: 2, source_kind: 'video', source: 'CNN', ts: 50000, summary: 'States and Iran over the Strait' },
  { id: 3, source_kind: 'video', source: 'CNN', ts: 90000, summary: 'of Hormuz as tensions rise' },     // gap <120s → same segment
  { id: 4, source_kind: 'video', source: 'CNN', ts: 400000, summary: 'now to sports and the World Cup' }, // gap >120s → NEW segment
  { id: 5, source_kind: 'video', source: 'ABC News', ts: 20000, summary: 'buy now at great prices' },     // different stream
  { id: 9, source_kind: 'rss', source: 'BBC', ts: 0, summary: 'not a video item' },                       // ignored
];
const segs = VR.groupIntoSegments(vids, { gapMs: 120000 });
ok(segs.length === 3, 'groups into 3 segments (CNN×2 by the 120s gap + ABC), RSS ignored');
const cnn1 = segs.find((s) => s.stream === 'CNN' && s.itemIds.includes(1));
ok(cnn1 && cnn1.itemIds.join(',') === '1,2,3' && cnn1.repId === 3, 'time-adjacent CNN flushes group; representative = latest (id3)');
ok(/Iran/.test(cnn1.captions) && /Hormuz/.test(cnn1.captions), 'segment captions are concatenated in order');
ok(segs.some((s) => s.stream === 'CNN' && s.itemIds.join() === '4'), 'a >gap flush starts a new segment');

// ===== reconstructValidator =====
ok(VR.reconstructValidator('[{"id":3,"headline":"US-Iran tensions rise over Strait of Hormuz","summary":"x","is_news":true}]').valid === true, 'validator: well-formed');
const fenced = VR.reconstructValidator('```json\n[{"id":3,"headline":"H","summary":"s","is_news":true}]\n```');
ok(fenced.valid === true && fenced.value[0].headline === 'H', 'validator: tolerates code fences');
const trunc = VR.reconstructValidator('[{"id":3,"headline":"Full one","summary":"s","is_news":true},{"id":4,"headline":"cut of');
ok(trunc.valid === true && trunc.value.length === 1 && trunc.value[0].id === 3, 'validator: recovers complete objects from truncation');
const adv = VR.reconstructValidator('[{"id":5,"is_news":false}]');
ok(adv.valid === true && adv.value[0].is_news === false, 'validator: keeps an is_news:false verdict with no headline (→ drop)');
ok(VR.reconstructValidator('[{"id":5,"is_news":true}]').valid === false, 'validator: a news verdict without a headline is rejected');

(async () => {
  // ===== reconstructBatch: cloud + fail-safe =====
  const askMock = async ({ input }) => input.map((i) => (i.id === 5 ? { id: 5, is_news: false } : { id: i.id, headline: 'US-Iran tensions over Hormuz', summary: 'Tensions rise.', entities: ['Iran', 'Strait of Hormuz', 'United States'], is_news: true }));
  const v = await VR.reconstructBatch(segs, { ask: askMock });
  ok(v[3] && /Hormuz/.test(v[3].headline) && v[3].isNews === true, 'reconstructBatch: news segment → clean headline');
  ok(v[3] && Array.isArray(v[3].entities) && v[3].entities.includes('Iran'), 'reconstructBatch: news segment → canonical entities (the bridge)');
  ok(v[5] && v[5].isNews === false, 'reconstructBatch: ad segment → is_news false');
  const vDown = await VR.reconstructBatch(segs, { ask: async () => { throw new Error('cloud down'); } });
  ok(Object.keys(vDown).length === 0, 'reconstructBatch: cloud down → empty (caller keeps raw, never invents)');

  // ===== runReconstruct: writes rep, absorbs others, drops non-news =====
  const calls = { text: [], absorbed: [], dropped: [] };
  const store = {
    updateItemText: (id, o) => { calls.text.push({ id, ...o }); return true; },
    absorbItems: (ids) => { calls.absorbed.push(...ids); return ids.length; },
    markDropped: (ids) => { calls.dropped.push(...ids); return ids.length; },
  };
  const r = await VR.runReconstruct(vids, { store, ask: askMock });
  ok(calls.text.some((t) => t.id === 3 && /Hormuz/.test(t.title) && Array.isArray(t.entities) && t.entities.includes('Iran')), 'runReconstruct: clean headline + canonical entities written onto the representative (id3)');
  ok(calls.absorbed.includes(1) && calls.absorbed.includes(2) && !calls.absorbed.includes(3), 'runReconstruct: non-representative flushes absorbed (1,2 not 3)');
  ok(calls.dropped.includes(5), 'runReconstruct: the ABC ad segment dropped (is_news false)');
  ok(r.reconstructed >= 2 && r.dropped >= 1, 'runReconstruct: tallies reconstructed + dropped');

  // fail-safe: no store → no throw
  const r2 = await VR.runReconstruct(vids, {});
  ok(r2.segments === 0 && r2.reconstructed === 0, 'runReconstruct: no store → safe no-op');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
