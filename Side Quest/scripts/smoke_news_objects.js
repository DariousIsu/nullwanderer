/* Smoke: lib/news_objects — the OBJECT VIEW over the news short-term store. Proves a compressed story is
 * reachable as an event OBJECT (resolveNewsObject), "news about X" traverses principals (newsAbout), and the
 * anti-glob corroboration gate holds (recentNewsObjects). Isolated NEWS_DB_PATH. Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_news_objects.js */
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const tmp = path.join(os.tmpdir(), `sq_newsobj_${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.db`);
try { fs.unlinkSync(tmp); } catch {}
process.env.NEWS_DB_PATH = tmp;

const lane = require('../lib/news_lane');
const NO = require('../lib/news_objects');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const NOW = 1_760_000_000_000;

(async () => {
  lane.ensureSchema();
  // A corroborated Kyiv story (BBC + CNN, distinct headlines → 2 outlets / 2 reports = corroboration 2), forced
  // to merge via the adjudicator so the test is deterministic; plus a single-source (corroboration 1) story.
  await lane.clusterItems([{ source: 'BBC', title: 'Russian forces strike Kyiv in a deadly overnight attack', summary: 'Kyiv officials report casualties.', ts: NOW }], { now: NOW });
  await lane.clusterItems([{ source: 'CNN', title: 'Kyiv reels after a massive Russian assault kills dozens', summary: 'The capital is hit again.', ts: NOW + 2000 }], { now: NOW, adjudicate: async () => true });
  await lane.clusterItems([{ source: 'US Top News', title: 'Google loses fight over record EU antitrust fine', summary: 'The European Commission penalty over Android.', ts: NOW + 3000 }], { now: NOW });

  const stories = lane.allStories();
  const kyiv = stories.find((s) => /Kyiv/.test(s.title));
  const google = stories.find((s) => /Google/.test(s.title));
  ok(kyiv && Math.min(kyiv.outlet_count, kyiv.report_count) === 2, 'setup: Kyiv story is corroborated (min(outlet,report)=2)');
  ok(google && Math.min(google.outlet_count, google.report_count) === 1, 'setup: Google story is single-source (corroboration 1)');

  // ===== resolveNewsObject =====
  const byId = NO.resolveNewsObject(kyiv.id);
  ok(byId && byId.type === 'event' && /Kyiv/.test(byId.name), 'resolveNewsObject(id) → an event object');
  ok(byId.corroboration && byId.corroboration.independent === 2 && Array.isArray(byId.principals) && byId.principals.length > 0, 'the object carries corroboration + principal connections');
  const byName = NO.resolveNewsObject('Kyiv');
  ok(byName && byName.id === kyiv.id, 'resolveNewsObject(name) resolves by title tokens');
  ok(NO.resolveNewsObject('nonexistent story zzz') === null, 'resolveNewsObject → null when nothing matches');

  // ===== newsAbout (the "news about X" graph traversal via principals) =====
  const aboutKyiv = NO.newsAbout('Kyiv');
  ok(aboutKyiv.length >= 1 && aboutKyiv.some((o) => o.id === kyiv.id), 'newsAbout(entity) returns the connected event objects');
  ok(NO.newsAbout('Kyiv', { minCorroboration: 2 }).some((o) => o.id === kyiv.id), 'newsAbout honors the corroboration gate (Kyiv corr 2 passes)');
  ok(NO.newsAbout('Google', { minCorroboration: 2 }).length === 0, 'newsAbout gate: single-source Google (corr 1) is filtered at minCorroboration 2');
  ok(NO.newsAbout('Google', { minCorroboration: 1 }).some((o) => /Google/.test(o.name)), 'newsAbout at minCorroboration 1 surfaces the single-source story');
  ok(NO.newsAbout('Zebra').length === 0, 'newsAbout an unmentioned entity → empty');

  // ===== recentNewsObjects (anti-glob view of the short-term store) =====
  const recent = NO.recentNewsObjects({ sinceMs: 0, minCorroboration: 2 });
  ok(recent.length === 1 && recent[0].id === kyiv.id, 'recentNewsObjects (gate 2) → only the corroborated story (Google stays in the pool)');
  ok(NO.recentNewsObjects({ sinceMs: 0, minCorroboration: 1 }).length === 2, 'lowering the gate widens the view to both');
  ok(recent[0].event_ref === null, 'a not-yet-promoted story object reports event_ref=null (short-term only; set once the overnight pass promotes it)');

  // ===== proposeEventObject: Echo response handling (audit fix — the news→Echo event-promotion path) =====
  const mock = (resp) => async () => ({ ok: true, text: JSON.stringify(resp) });
  const pe = (resp, name = 'Some event') => lane.proposeEventObject({ dispatch: mock(resp), name });
  // merge_suggested = event already exists as a PUBLIC entity → adopt that id, NOT a failure (was 5/7 errors)
  const merged = await pe({ action: 'merge_suggested', similar_to: { id: 4242, name: 'Existing event' }, similarity: 0.94 });
  ok(merged.ok && merged.entityId === 4242 && merged.proposed === false, 'merge_suggested adopts similar_to.id as an already-public event (no promote)');
  // a merge_suggested with no usable target id is still a miss (nothing to adopt)
  const mergedNoId = await pe({ action: 'merge_suggested', similarity: 0.9 });
  ok(!mergedNoId.ok && mergedNoId.action === 'merge_suggested', 'merge_suggested WITHOUT a target id → still unusable');
  // already_proposed = a pending tenant proposal → usable, needs promotion (was wrongly rejected)
  const alreadyProp = await pe({ action: 'already_proposed', entity_id: 77 });
  ok(alreadyProp.ok && alreadyProp.entityId === 77 && alreadyProp.proposed === true, 'already_proposed is usable + flagged for promotion');
  // the happy paths still hold
  ok((await pe({ action: 'proposed', entity_id: 5 })).proposed === true, 'proposed → needs promotion');
  ok((await pe({ action: 'created', entity_id: 6 })).proposed === false, 'created → already public');
  ok((await pe({ action: 'already_exists', entity_id: 7 })).proposed === false, 'already_exists → already public');
  ok(!(await pe({ action: 'rejected', error: 'x' })).ok, 'rejected → not ok (fail-soft, logged)');

  try { fs.unlinkSync(tmp); } catch {}
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
