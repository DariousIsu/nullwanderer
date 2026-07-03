/**
 * Offline smoke for lib/news_feed.js — the forecasting⇄news contract (pure cores + injected live wrappers).
 * Run: node scripts/smoke_news_feed.js
 */
const NF = require('../lib/news_feed');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } }
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }

// --- corroboration helper: min(outlets, reports), tier ---
eq('corroboration = min(outlet,report)', NF.storyCorroboration({ outlet_count: 8, report_count: 2 }), 2);
eq('corroboration falls back to source_count', NF.storyCorroboration({ outlet_count: 0, report_count: 0, source_count: 3 }), 3);
eq('tier widely', NF.tierOf(5), 'widely reported');
eq('tier corroborated', NF.tierOf(2), 'corroborated');
eq('tier single', NF.tierOf(1), 'single-source');

// --- eventsFrom: corroboration gate + entity filter ---
const stories = [
  { id: 1, title: 'Ohio Senate race tightens as Vance leads', entity_set: ['JD Vance', 'Ohio'], summary: 's', outlet_count: 6, report_count: 5, last_ts: 300, category: 'politics' },
  { id: 2, title: 'Single blog rumor about a candidate', entity_set: ['JD Vance'], outlet_count: 1, report_count: 1, last_ts: 400 },
  { id: 3, title: 'Weather system over Florida', entity_set: ['Florida'], outlet_count: 4, report_count: 4, last_ts: 350, category: 'weather' },
];
const ev = NF.eventsFrom(stories, { minCorroboration: 2 });
eq('events: single-source story dropped by corroboration gate', ev.map((e) => e.id), [1, 3]);
eq('events: ranked by corroboration desc', ev[0].id, 1);
eq('events: tier computed', ev[0].tier, 'widely reported');
const evVance = NF.eventsFrom(stories, { minCorroboration: 2, entities: ['Vance'] });
eq('events: entity filter keeps only matching', evVance.map((e) => e.id), [1]);
eq('events: matched entities reported', evVance[0].matched, ['Vance']);
ok('events: entity match is case/substring tolerant', NF.eventsFrom(stories, { entities: ['ohio'] }).length === 1);

// --- momentumFrom: per-entity volume incl. video CC split ---
const items = [
  { source_kind: 'rss', title: 'Vance campaigns in Cleveland', summary: '', ts: 100 },
  { source_kind: 'video', title: 'BREAKING VANCE RALLY', entities: ['JD Vance'], ts: 150 },
  { source_kind: 'video', title: 'more on vance tonight', ts: 200 },
  { source_kind: 'newsletter', title: 'Weekly digest: Florida governor', ts: 120 },
  { source_kind: 'rss', title: 'unrelated tech story', ts: 130 },
];
const mo = NF.momentumFrom(items, { entities: ['Vance', 'Florida'] });
const vance = mo.find((m) => m.entity === 'Vance');
eq('momentum: Vance total mentions', vance.mentions, 3);
eq('momentum: video CC mentions counted separately', vance.video_mentions, 2);
eq('momentum: by_source_kind split', vance.by_source_kind, { rss: 1, video: 2 });
eq('momentum: first/last ts tracked', [vance.first_ts, vance.last_ts], [100, 200]);
eq('momentum: sentiment placeholder null', vance.sentiment, null);
eq('momentum: Florida picked up from newsletter', mo.find((m) => m.entity === 'Florida').mentions, 1);

// --- live wrappers with INJECTED readers (no bucket) ---
const fakeLane = { storiesActiveInWindow: () => stories };
const fakeStore = { recentItems: () => items };
eq('events() via injected lane', NF.events({ startMs: 0, entities: ['Vance'], lane: fakeLane }).map((e) => e.id), [1]);
eq('momentum() via injected store', NF.momentum({ sinceMs: 0, entities: ['Vance'], store: fakeStore })[0].video_mentions, 2);

// --- raw(): firehose passthrough + sourceKind filter (injected store) ---
const rawStore = { recentItems: ({ sinceMs }) => items.filter((i) => (i.ts || 0) >= (sinceMs || 0)) };
eq('raw(): passthrough returns every item', NF.raw({ sinceMs: 0, store: rawStore }).length, items.length);
eq('raw(): sourceKind filter keeps only video', NF.raw({ sinceMs: 0, sourceKind: 'video', store: rawStore }).map((i) => i.source_kind), ['video', 'video']);
eq('raw(): sinceMs window respected', NF.raw({ sinceMs: 140, store: rawStore }).length, 2);
eq('raw() broken reader → []', NF.raw({ store: { recentItems: () => { throw new Error('down'); } } }), []);

// --- layers(): hourly markers, since-filtered (injected lane) ---
const layerRows = [
  { hour_start: 300, hour_end: 360, briefing: 'hour 2', item_count: 9, story_count: 3 },
  { hour_start: 100, hour_end: 160, briefing: 'hour 1', item_count: 5, story_count: 2 },
];
const layerLane = { recentLayers: () => layerRows };
eq('layers(): newest-first passthrough', NF.layers({ sinceMs: 0, lane: layerLane }).map((l) => l.hour_start), [300, 100]);
eq('layers(): sinceMs drops older markers', NF.layers({ sinceMs: 200, lane: layerLane }).map((l) => l.hour_start), [300]);
eq('layers() broken reader → []', NF.layers({ lane: { recentLayers: () => { throw new Error('down'); } } }), []);

// --- digest(): durable 24h markers, since-filtered (injected lane) ---
const dayRows = [
  { day_start: 172800000, day_end: 172810000, briefing: 'day 2', story_count: 4, promoted: 3, event_refs: [11, 12, 13] },
  { day_start: 86400000, day_end: 86410000, briefing: 'day 1', story_count: 2, promoted: 1, event_refs: [7] },
];
const dayLane = { recentDays: () => dayRows };
eq('digest(): durable day markers newest-first', NF.digest({ sinceMs: 0, lane: dayLane }).map((d) => d.day_start), [172800000, 86400000]);
eq('digest(): event_refs (Echo long-term links) surfaced', NF.digest({ sinceMs: 0, lane: dayLane })[0].event_refs, [11, 12, 13]);
eq('digest(): sinceMs drops older days', NF.digest({ sinceMs: 100000000, lane: dayLane }).map((d) => d.day_start), [172800000]);
eq('digest() broken reader → []', NF.digest({ lane: { recentDays: () => { throw new Error('down'); } } }), []);

// --- today(): LIVE current-day event objects (injected objects + lane), with entity filter ---
const dayObjects = [
  { id: 1, name: 'Ohio Senate race tightens as Vance leads', principals: ['jd vance', 'ohio'], summary: 's', event_ref: 900 },
  { id: 3, name: 'Weather system over Florida', principals: ['florida'], summary: '', event_ref: null },
];
const objLane = { startOfDayMs: () => 0 };
const fakeObjects = { recentNewsObjects: ({ sinceMs }) => dayObjects.filter(() => sinceMs >= 0) };
eq('today(): assembles the day’s corroborated objects', NF.today({ sinceMs: 0, lane: objLane, objects: fakeObjects }).map((o) => o.id), [1, 3]);
eq('today(): entity filter matches name/principals', NF.today({ sinceMs: 0, entities: ['Vance'], lane: objLane, objects: fakeObjects }).map((o) => o.id), [1]);
eq('today(): event_ref carried (Echo long-term link)', NF.today({ sinceMs: 0, lane: objLane, objects: fakeObjects })[0].event_ref, 900);
eq('today() broken reader → []', NF.today({ lane: objLane, objects: { recentNewsObjects: () => { throw new Error('down'); } } }), []);

// --- fail-soft ---
eq('eventsFrom([]) → []', NF.eventsFrom([]), []);
eq('momentum with broken reader → zeroed entities', NF.momentum({ entities: ['X'], store: { recentItems: () => { throw new Error('db down'); } } })[0].mentions, 0);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
