/* Smoke: lib/news_lane — the compression heart (Stage-1 normalize + Stage-2 rolling-story clustering +
 * hourly layer). Uses the REAL Kyiv cross-source fixture. ISOLATED temp DB. Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_news_lane.js
 */
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = path.join(os.tmpdir(), `sq_newslane_smoke_${process.pid}.db`);
try { fs.unlinkSync(tmp); } catch {}
process.env.NEWS_DB_PATH = tmp;

const newsdb = require('../lib/news_db');
const store = require('../lib/news_store');
const lane = require('../lib/news_lane');
lane.ensureSchema();   // create news_stories/news_layers before any raw DELETE below

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const clearStories = () => newsdb.get().exec('DELETE FROM news_stories');

const T = 1_700_000_000_000;
const NOW = T + 10000;
const kyivBBC = { source: 'BBC', title: "At least 18 killed in 'most massive' Russian attack on Kyiv", summary: "Kyiv's mayor declares a day of mourning.", ts: T };
const kyivNBC = { source: 'NBC News', title: "Russian attacks kill at least 17 in Kyiv after Zelenskyy warned of 'massive strike'", summary: 'Russia launched a large-scale attack on the capital.', ts: T + 1000 };
const kyivDup = { source: 'CNN', title: 'At least 18 killed in most massive Russian attack on Kyiv city', summary: 'The same attack on the capital.', ts: T + 2000 };
const antitrust = { source: 'US Top News', title: 'Google loses fight over record $4.7 billion EU antitrust fine', summary: 'The European Commission penalty over Android.', ts: T + 3000 };

(async () => {
  // ===== PURE HELPERS =====
  ok(lane.jaccard(new Set(['a', 'b']), new Set(['b', 'c'])) === 1 / 3, 'jaccard basic');
  const sBBC = lane.signatureOf(kyivBBC), sNBC = lane.signatureOf(kyivNBC), sDup = lane.signatureOf(kyivDup);
  ok(sBBC.entities.has('kyiv') && sBBC.entities.has('russian'), 'entitySet extracts principals (Kyiv, Russian)');

  const scoreCross = lane.continuationScore(sBBC, sNBC);
  ok(scoreCross >= 0.30 && scoreCross < 0.60, `cross-source Kyiv variants land in the MODEL-ADJUDICATION band (S=${scoreCross.toFixed(2)}) — deterministic gate alone won't merge them`);
  const scoreDup = lane.continuationScore(sBBC, sDup);
  ok(scoreDup >= 0.60, `near-identical headline auto-continues (S=${scoreDup.toFixed(2)} ≥ .60)`);
  const scoreDiff = lane.continuationScore(sBBC, lane.signatureOf(antitrust));
  ok(scoreDiff < 0.30, `unrelated story is clearly new (S=${scoreDiff.toFixed(2)} < .30)`);
  ok(lane.classifyContinuation(0.7) === 'continue' && lane.classifyContinuation(0.2) === 'new' && lane.classifyContinuation(0.45) === 'ambiguous', 'classifyContinuation bands');

  // aggregator <ol> parse
  const aggMembers = lane.parseAggregatorMembers('<ol><li><a href="x">Kyiv attack kills 17</a>&nbsp;&nbsp;<font color="#6f6f6f">NBC News</font></li><li><a href="y">Russia hammers capital</a>&nbsp;&nbsp;<font color="#6f6f6f">The New York Times</font></li></ol>');
  ok(aggMembers.length === 2 && aggMembers[0].outlet === 'NBC News' && /kyiv attack/i.test(aggMembers[0].headline), 'parseAggregatorMembers extracts member {outlet, headline}');

  // growing-caption collapse (the real probe shape)
  const grown = lane.dedupeGrowingCaptions(['surprise repairs with a warranty from', 'surprise repairs with a warranty from Cinch Home Services. Fast', 'award-winning service backed by']);
  ok(grown.length === 2 && /Fast/.test(grown[0]), 'dedupeGrowingCaptions collapses the growing caption window to settled lines');

  // ad strip (first-cut)
  ok(lane.isAdLine('Visit shopcinch.com/offer and get 30% off any plan.') === true, 'isAdLine catches an obvious CTA/promo line');
  ok(lane.isAdLine('At least 18 killed in Kyiv.') === false, 'isAdLine does not flag a news line');
  ok(lane.stripAdLines(['news one', 'get 30% off now', 'news two']).length === 2, 'stripAdLines removes ad lines');

  // top-of-hour repeat collapse
  const collapsed = lane.collapseRepeatedTitles([kyivBBC, { title: 'At least 18 killed in the most massive Russian attack on Kyiv' }, antitrust]);
  ok(collapsed.length === 2, 'collapseRepeatedTitles drops a near-identical looped headline');

  // stripSourceSuffix: drop the Google-News " - Outlet" / " | Outlet" tag, case-preserving
  ok(lane.stripSourceSuffix('Senate passes the budget bill - Politico') === 'Senate passes the budget bill', 'stripSourceSuffix drops a trailing " - Outlet" aggregator tag');
  ok(lane.stripSourceSuffix('Oil prices spike | Reuters') === 'Oil prices spike', 'stripSourceSuffix drops a trailing " | Outlet" tag');
  ok(lane.stripSourceSuffix('Massive attack on Kyiv') === 'Massive attack on Kyiv', 'stripSourceSuffix leaves a plain headline unchanged');
  ok(lane.stripSourceSuffix('- Politico') === '- Politico', 'stripSourceSuffix never empties a title (fallback to original)');
  clearStories();
  await lane.clusterItems([{ source: 'Google News', title: 'Historic climate deal reached at summit - The New York Times', summary: 'x', ts: T }], { now: NOW });
  ok(lane.allStories()[0].title === 'Historic climate deal reached at summit', 'a story from a Google-News item stores the title WITHOUT the aggregator suffix');

  // ===== CONFIRMATION (corroboration + redaction) =====
  ok(JSON.stringify(lane.outletsOf({ source: 'Google News', members: [{ outlet: 'NBC' }, { outlet: 'NYT' }, { outlet: 'NBC' }] })) === JSON.stringify(['NBC', 'NYT']), 'outletsOf pulls + dedups aggregator member outlets');
  ok(JSON.stringify(lane.outletsOf({ source: 'BBC News' })) === JSON.stringify(['BBC News']), 'outletsOf falls back to the source for a plain feed');
  ok(lane.outletsOf({ source: 'GN', summary: '<ol><li><a>H1</a>&nbsp;<font color="#6f6f6f">Reuters</font></li><li><a>H2</a>&nbsp;<font color="#6f6f6f">CNN</font></li></ol>' }).length === 2, 'outletsOf parses outlets from an aggregator <ol> summary');
  ok(lane.detectRedactionSignal('Outlet issues a correction to earlier report').kind === 'correction', 'detectRedactionSignal catches a correction');
  ok(lane.detectRedactionSignal('Newspaper retracts the story after review').kind === 'retraction', 'detectRedactionSignal catches a retraction');
  ok(lane.detectRedactionSignal('Trump denies conflict of interest') === null, 'detectRedactionSignal does NOT flag subject-level denial (not a source redaction)');
  ok(lane.corroborationTier(1) === 'single-source' && lane.corroborationTier(3) === 'corroborated' && lane.corroborationTier(6) === 'widely reported', 'corroborationTier bands');

  clearStories(); newsdb.get().exec('DELETE FROM news_story_updates');
  await lane.clusterItems([{ source: 'Google News', title: 'Kyiv attack', summary: 'strike', members: [{ outlet: 'NBC' }, { outlet: 'NYT' }, { outlet: 'CNBC' }], ts: T }], { now: NOW });
  const aggStory = lane.allStories()[0];
  ok(aggStory.outlet_count === 3, 'a story from an aggregator item counts its member outlets (real corroboration, not just feed count)');
  ok(aggStory.report_count === 3, 'aggregator members are independent reports → report_count 3 (genuine corroboration)');
  const conf = lane.storyConfirmation(aggStory);
  ok(conf.corroborationCount === 3 && conf.reportCount === 3 && conf.outletCount === 3 && conf.tier === 'corroborated' && conf.redaction === false, 'storyConfirmation summarizes corroboration (min outlets,reports) + reach + integrity');

  // SINGLE-OUTLET inflation guard: one outlet publishing many distinct-headline articles that cluster
  // must NOT read as widely-reported — corroboration = min(outlets, reports) = 1 (proven live: a paper's
  // "2001 girls soccer" archive cluster showed 10 reports / 1 outlet before this bound).
  clearStories(); newsdb.get().exec('DELETE FROM news_story_updates');
  await lane.clusterItems([{ source: 'The Gazette', title: 'Mayor Karen Bass unveils Los Angeles budget plan', summary: 'a', ts: T }], { now: NOW });
  await lane.clusterItems([{ source: 'The Gazette', title: 'Los Angeles council debates Mayor Karen Bass budget proposal', summary: 'b', ts: T + 1 }], { now: NOW, adjudicate: async () => true });
  await lane.clusterItems([{ source: 'The Gazette', title: 'Mayor Karen Bass defends Los Angeles budget amid criticism', summary: 'c', ts: T + 2 }], { now: NOW, adjudicate: async () => true });
  const soStory = lane.allStories()[0];
  ok(lane.allStories().length === 1 && soStory.outlet_count === 1 && soStory.report_count === 3, 'single outlet, 3 distinct articles → ONE story, outlet_count 1, report_count 3');
  const soConf = lane.storyConfirmation(soStory);
  ok(soConf.corroborationCount === 1 && soConf.tier === 'single-source', 'single-outlet multi-article does NOT inflate corroboration: min(1,3)=1 → single-source');

  // AD-FILTER: a video segment classified 'ad' is DROPPED in runCompression (never becomes a story); a
  // real news video segment still clusters. Uses the real store (markDropped sentinel) + an injected classifier.
  clearStories(); newsdb.get().exec('DELETE FROM news_story_updates');
  store.insertItems([
    { source: 'CNN', sourceKind: 'video', urlOrGuid: 'vid:ad:1', title: 'Huge savings event this weekend', summary: 'Order now and save big at our stores', ts: T + 20 },
    { source: 'CNN', sourceKind: 'video', urlOrGuid: 'vid:news:1', title: 'Senate passes the budget bill', summary: 'The Senate passed the budget, officials said.', ts: T + 21 },
  ], NOW);
  const rc = await lane.runCompression({
    store, startMs: T, endMs: NOW + 1000, now: NOW, writeLayer: false,
    classifyAds: async (vids) => { const v = {}; for (const x of vids) v[x.id] = /savings|order now|save big/i.test(x.summary || x.title) ? 'ad' : 'news'; return v; },
  });
  ok(rc.droppedAds === 1, 'runCompression: the ad-classified video segment is dropped');
  ok(lane.allStories().some((s) => /Senate/.test(s.title)) && !lane.allStories().some((s) => /savings|save big/i.test(s.title)), 'the news video segment became a story; the ad did not');

  // SYNDICATION DEDUP: a wire story republished verbatim across N outlets is ONE report, not N — the
  // fake-"widely reported" fix (proven live: identical States-Newsroom /repub/ copies across states).
  clearStories(); newsdb.get().exec('DELETE FROM news_story_updates');
  const wireTitle = 'Medicaid to again cover Planned Parenthood as GOP ban ends';
  for (const src of ['Missouri Independent', 'Oklahoma Voice', 'North Dakota Monitor', 'Arkansas Advocate', 'Maine Morning Star']) {
    await lane.clusterItems([{ source: src, title: wireTitle, summary: 'Job growth slowed in June.', url_or_guid: `https://x/2026/07/02/repub/medicaid?src=${encodeURIComponent(src)}`, ts: T }], { now: NOW });
  }
  const synStory = lane.allStories()[0];
  ok(lane.allStories().length === 1, 'syndication: 5 newsrooms carrying the identical wire headline cluster into ONE story');
  ok(synStory.outlet_count === 5, 'syndication: outlet_set still records REACH (5 outlets carried it)');
  ok(synStory.report_count === 1, 'syndication: but it counts as ONE independent report (identical headline collapses across outlets)');
  const synConf = lane.storyConfirmation(synStory);
  ok(synConf.tier === 'single-source' && synConf.syndicated === true, 'syndication: tier is single-source (NOT "widely reported") and flagged syndicated');
  ok(!/reports/.test(lane.buildBriefing([synStory])), 'syndication: briefing shows no corroboration badge for a single-report syndicated story');
  ok(lane.isSyndicatedRepublication({ url_or_guid: 'https://x/2026/07/02/repub/medicaid' }) === true && lane.isSyndicatedRepublication({ url_or_guid: 'https://x/news/medicaid' }) === false, 'isSyndicatedRepublication detects the /repub/ marker');

  clearStories(); newsdb.get().exec('DELETE FROM news_story_updates');
  await lane.clusterItems([{ source: 'AP', title: 'Senator Smith accused of fraud', summary: 'allegations', ts: T }], { now: NOW });
  await lane.clusterItems([{ source: 'AP', title: 'Senator Smith accused of fraud (correction)', summary: 'We issue a correction to the earlier report.', ts: T + 1000 }], { now: NOW });
  const redStory = lane.allStories()[0];
  ok(redStory.update_count === 2 && redStory.redaction === 1 && /correction/.test(redStory.redaction_note), 'a correction/retraction in an update flags redaction on the story');

  // ===== STAGE-2 CLUSTERING =====
  // A) no adjudicator → ambiguous cross-source pair opens a SECOND story (conservative default)
  clearStories();
  ok((await lane.clusterItems([kyivBBC], { now: NOW })).created === 1, 'A: first Kyiv item creates a story');
  const A2 = await lane.clusterItems([kyivNBC], { now: NOW });
  ok(A2.created === 1 && lane.allStories().length === 2, 'A: cross-source Kyiv variant with NO adjudicator → new story (band is ambiguous, default conservative)');

  // B) adjudicator returns true → the ambiguous pair CONTINUES into one story
  clearStories();
  await lane.clusterItems([kyivBBC], { now: NOW });
  const B2 = await lane.clusterItems([kyivNBC], { now: NOW, adjudicate: async () => true });
  const bStories = lane.allStories();
  ok(B2.attached === 1 && bStories.length === 1 && bStories[0].source_count === 2, 'B: adjudicator=true merges the cross-source pair → ONE story, source_count=2');

  // C) near-identical headline AUTO-continues (no adjudicator needed)
  clearStories();
  await lane.clusterItems([kyivBBC], { now: NOW });
  const C2 = await lane.clusterItems([kyivDup], { now: NOW });
  ok(C2.attached === 1 && lane.allStories().length === 1, 'C: near-identical headline auto-continues (S ≥ .60)');

  // D) unrelated item → new story
  const D = await lane.clusterItems([antitrust], { now: NOW });
  ok(D.created === 1 && lane.allStories().length === 2, 'D: unrelated story opens its own cluster');

  // E) story_id linkage on a REAL reservoir row
  clearStories();
  const ins = store.insertItem({ source: 'BBC', urlOrGuid: 'bbc-kyiv', title: kyivBBC.title, summary: kyivBBC.summary, ts: T });
  const row = store.recentItems({ limit: 10 }).find(r => r.id === ins.id);
  await lane.clusterItems([row], { now: NOW });
  const linked = store.recentItems({ limit: 10 }).find(r => r.id === ins.id);
  ok(linked.story_id != null, 'E: clustering sets news_items.story_id on the real reservoir row');

  // F) cold-close
  clearStories();
  await lane.clusterItems([{ source: 'BBC', title: 'old story', summary: '', ts: T }], { now: T });
  const closed = lane.closeStaleStories({ now: T + 7 * 3600 * 1000, coldMs: 6 * 3600 * 1000 });
  ok(closed === 1 && lane.openStories({ now: T + 7 * 3600 * 1000 }).length === 0, 'F: closeStaleStories closes a story cold for > 6h');

  // G) briefing + layer
  clearStories();
  await lane.clusterItems([kyivBBC], { now: NOW });
  await lane.clusterItems([kyivDup], { now: NOW });         // → same story, source_count 2
  await lane.clusterItems([antitrust], { now: NOW });        // → separate
  const briefing = lane.buildBriefing(lane.allStories());
  ok(/\(2 reports\)/.test(briefing) && briefing.split('\n').length === 2, 'G: buildBriefing ranks by corroboration + labels multi-report stories');
  const layerId = lane.createLayer({ hourStart: T, hourEnd: T + 3600000, briefing, itemCount: 3, storyCount: 2, now: NOW });
  ok(layerId && lane.recentLayers(5).length === 1 && lane.recentLayers(5)[0].story_count === 2, 'G: createLayer persists an hourly layer');

  // ===== DEVELOPING-STORY DELTAS =====
  clearStories();
  newsdb.get().exec('DELETE FROM news_story_updates');
  await lane.clusterItems([kyivBBC], { now: NOW });   // born (BBC)
  await lane.clusterItems([kyivDup], { now: NOW });    // update (CNN) → developing
  const devStory = lane.allStories()[0];
  ok(devStory.update_count === 2, 'a twice-touched story has update_count=2 (developing)');
  const deltas = lane.storyDeltas(devStory.id);
  ok(deltas.length === 2 && deltas[0].kind === 'born' && deltas[1].kind === 'update', 'storyDeltas logs born + each update, in order');
  ok(deltas[0].source === 'BBC' && deltas[1].source === 'CNN', 'deltas carry the contributing source per step (the evolution over the life of the story)');
  const fmt = lane.formatDeltas(deltas);
  ok(/▸ \[BBC\]/.test(fmt) && /• \[CNN\]/.test(fmt), 'formatDeltas renders the developing-story timeline');
  ok(/\(developing\)/.test(lane.buildBriefing(lane.allStories())), 'buildBriefing flags a developing story');

  // ===== DAILY PASS (worthy stories → PUBLIC Echo event objects via propose→promote; mocked dispatch) =====
  function mkDispatchState({ knownTargets = null } = {}) {
    const calls = { propose_entity: [], promote_proposal: [], propose_relation: [], landDoc: [], web_extract: [] };
    let pid = 100;
    const dispatch = async (tag) => {
      // web_extract (trafilatura) — clean body under `text_preview` (the REAL shape, guards the parse key).
      if (tag.name === 'web_extract') { calls.web_extract.push(tag.args); return { ok: true, text: JSON.stringify({ url: tag.args.url, extractor: 'trafilatura', text_preview: 'FULL ARTICLE BODY: Ukrainian officials named the districts hit in Kyiv; 18 dead, 40 wounded.', text_chars: 86 }) }; }
      // Echo's external write surface lands every write as a tenant PROPOSAL (action:'proposed', a proposal id).
      if (tag.name === 'propose_entity') { calls.propose_entity.push(tag.args); return { ok: true, text: JSON.stringify({ action: 'proposed', entity_id: ++pid, name: tag.args.name }) }; }
      // promote_proposal copies the tenant proposal into the PUBLIC graph → returns the public entity_id (id+4900 here, so the chain is assertable).
      if (tag.name === 'promote_proposal') { calls.promote_proposal.push(tag.args); return { ok: true, text: JSON.stringify({ entity_id: Number(tag.args.proposal_id) + 4900 }) }; }
      // REALISTIC Echo behavior: a rejected proposal (missing endpoint / not-whitelisted) still returns
      // transport ok=true, with action:'rejected' in the body — only the body distinguishes accept vs reject.
      if (tag.name === 'propose_relation') { calls.propose_relation.push(tag.args); const good = knownTargets ? knownTargets.includes(tag.args.target_name) : true; return { ok: true, text: JSON.stringify({ action: good ? 'created' : 'rejected' }) }; }
      return { ok: false };
    };
    const landDoc = async (d) => { calls.landDoc.push(d); return { landed: true }; };
    return { dispatch, landDoc, calls };
  }

  clearStories();
  await lane.clusterItems([kyivBBC], { now: NOW });
  await lane.clusterItems([kyivDup], { now: NOW });   // BBC+CNN, distinct headlines → ONE story, corroboration 2
  await lane.clusterItems([antitrust], { now: NOW });  // single-source → corroboration 1
  // ANTI-GLOB gate: only stories past the corroboration bar (default 2) are worthy of the public graph
  const forDaily = lane.storiesForDaily({ now: NOW });
  ok(forDaily.length === 1 && /Kyiv/.test(forDaily[0].title), 'storiesForDaily gate: only the corroborated story is worthy (single-source antitrust stays in the raw pool)');
  ok(lane.storiesForDaily({ now: NOW, minCorroboration: 1 }).length === 2, 'lowering the corroboration bar widens the net (antitrust included)');

  // TOPIC RECALL (the silo-fix producer) — chat answering + research can pull the tracked stories for a topic
  // NOW, not just the next-day Echo promotion. Token LIKE over title/summary/entity_set + a note shaper.
  const kyivHits = lane.storiesForTopic('Kyiv strike', { now: NOW });
  ok(kyivHits.length >= 1 && /Kyiv/.test(kyivHits[0].title), 'storiesForTopic: an entity token ("Kyiv") surfaces the tracked story');
  ok(lane.storiesForTopic('zzzznomatchtoken', { now: NOW }).length === 0, 'storiesForTopic: no token match → []');
  // RELEVANCE FLOOR (audit fix): an entity token clears the floor alone; a generic word that only appears in a
  // summary substring does NOT (was the OR-of-LIKE noise leak). "mourning" is in the Kyiv summary but not an entity.
  ok(lane.storiesForTopic('Kyiv', { now: NOW }).length >= 1, 'storiesForTopic: a lone ENTITY token clears the relevance floor');
  ok(lane.storiesForTopic('mourning', { now: NOW }).length === 0, 'storiesForTopic: a lone generic summary-word stays BELOW the floor (no spurious pull)');
  ok(lane.storiesForTopic('who', { now: NOW }).length === 0, 'storiesForTopic: an interrogative ("who") is not a topic token');
  const newsNotes = lane.storiesAsNotes(kyivHits);
  ok(newsNotes.length >= 1 && newsNotes[0].source === 'news' && /Kyiv/.test(newsNotes[0].content), 'storiesAsNotes: stories → knowledge-shaped [news] notes for the recall pipeline');

  const DP = mkDispatchState();
  const r1 = await lane.runDailyPass({ dispatch: DP.dispatch, landDoc: DP.landDoc, now: NOW });
  ok(r1.promoted === 1 && r1.docs === 1, 'runDailyPass promotes ONLY the worthy (corroborated) story');
  ok(DP.calls.propose_entity.length === 1 && DP.calls.propose_entity[0].entity_type === 'event', 'the worthy story is proposed as entity_type=event');
  ok(DP.calls.promote_proposal.length === 1 && DP.calls.promote_proposal[0].proposal_id != null, 'the tenant proposal is PROMOTED into the public graph (propose → promote_proposal, two-step)');
  const kyivStory = lane.allStories().find(s => /Kyiv/.test(s.title));
  ok(kyivStory && Number(kyivStory.event_ref) === Number(DP.calls.promote_proposal[0].proposal_id) + 4900, 'event_ref = the PUBLIC entity_id from promote_proposal (not the tenant proposal id)');
  ok(DP.calls.landDoc.some(d => d.source === 'news' && /^news:story:/.test(d.ref)), 'the evidence doc lands with source=news + a stable story ref');

  const r2 = await lane.runDailyPass({ dispatch: DP.dispatch, landDoc: DP.landDoc, now: NOW });
  ok(r2.promoted === 0 && r2.updated === 1 && DP.calls.propose_entity.length === 1, 'second daily pass is idempotent (0 new, updated=1, no re-propose/promote)');

  // ===== DAILY (24h) MEMORY MARKER: runDailyPass writes a durable per-day digest row (self-contained) =====
  clearStories(); newsdb.get().exec('DELETE FROM news_story_updates');
  await lane.clusterItems([kyivBBC], { now: NOW });
  await lane.clusterItems([kyivDup], { now: NOW });     // BBC+CNN → corroborated (2 reports), worthy
  const DM = mkDispatchState();
  const dpm = await lane.runDailyPass({ dispatch: DM.dispatch, landDoc: DM.landDoc, now: NOW });
  const dayStart = lane.startOfDayMs(NOW);
  ok(dpm.dayMarker === dayStart, 'runDailyPass returns the day-marker key (start-of-day)');
  const dm = lane.dayMarker(dayStart);
  const kStory = lane.allStories().find((s) => /Kyiv/.test(s.title));
  ok(dm && dm.story_count === 1 && dm.promoted === 1, 'the day marker records the day’s worthy-story + promoted counts');
  ok(Array.isArray(dm.event_refs) && dm.event_refs.length === 1 && Number(dm.event_refs[0]) === Number(kStory.event_ref), 'the day marker carries the promoted Echo event_refs (the long-term links)');
  ok(/Kyiv/.test(dm.briefing || ''), 'the day marker stores the corroboration-ranked digest briefing');
  ok(lane.recentDays(5)[0].day_start === dayStart, 'recentDays returns the marker newest-first');
  // idempotent per day: a second same-day pass UPDATES the one row (promoted now 0, still one marker for the day)
  const daysBefore = lane.recentDays(50).length;
  const dpm2 = await lane.runDailyPass({ dispatch: DM.dispatch, landDoc: DM.landDoc, now: NOW });
  ok(dpm2.dayMarker === dayStart && lane.recentDays(50).length === daysBefore && lane.dayMarker(dayStart).promoted === 0, 'a same-day re-run UPDATES the one marker (idempotent per start-of-day; promoted=0 on the idempotent pass)');

  // edges only form to endpoints that already exist (fail-soft, eventually consistent, no mistyped dups)
  clearStories();
  await lane.clusterItems([kyivDup], { now: NOW });
  const D2 = mkDispatchState({ knownTargets: ['Kyiv'] });
  const rp = await lane.promoteStory(lane.allStories()[0], { dispatch: D2.dispatch, landDoc: D2.landDoc, now: NOW });
  ok(rp.event === true && D2.calls.promote_proposal.length === 1, 'promoteStory: propose→promote makes the event public before edging');
  ok(rp.edges >= 1 && D2.calls.propose_relation.some(a => a.target_name === 'Kyiv' && a.relation_type === 'LINKED_TO'), 'promoteStory forges event→principal edges with a WHITELISTED type (LINKED_TO, not the rejected "involves")');
  ok(D2.calls.propose_relation.some(a => a.target_name !== 'Kyiv'), 'promoteStory also ATTEMPTS edges to not-yet-existing principals (they fail soft, form on a later pass)');
  ok(rp.edges === D2.calls.propose_relation.filter(a => a.target_name === 'Kyiv').length, 'only ACCEPTED edges count — a rejected proposal (transport-ok, action:rejected) is NOT miscounted as an edge');

  // ===== CLUSTER ADJUDICATOR (ambiguous-band tiebreaker) =====
  ok(lane.adjValidate('{"same":true}').value.same === true && lane.adjValidate('prose {"same":false} x').value.same === false, 'adjValidate parses {same:bool} (even in prose)');
  ok(lane.adjValidate('nope').valid === false && lane.adjValidate('{"x":1}').valid === false, 'adjValidate rejects non-JSON / missing same');
  ok(await lane.adjudicateSameEvent({ title: 'A', entity_set: new Set(['kyiv']) }, { title: 'B' }, { ask: async () => ({ same: true }) }) === true, 'adjudicateSameEvent → true when cloud says same');
  ok(await lane.adjudicateSameEvent({ title: 'A' }, { title: 'B' }, { ask: async () => ({ same: false }) }) === false, 'adjudicateSameEvent → false when cloud says different');
  ok(await lane.adjudicateSameEvent({ title: 'A' }, { title: 'B' }, {}) === false, 'adjudicateSameEvent → false-safe with no ask (never merges on error)');
  ok(await lane.adjudicateSameEvent({ title: 'A' }, { title: 'B' }, { ask: async () => { throw new Error('x'); } }) === false, 'adjudicateSameEvent → false-safe when ask throws');
  // end-to-end: the adjudicator merges the ambiguous cross-source Kyiv pair (S=0.42, middle band)
  clearStories(); newsdb.get().exec('DELETE FROM news_story_updates');
  await lane.clusterItems([kyivBBC], { now: NOW });
  const adjMerge = await lane.clusterItems([kyivNBC], { now: NOW, adjudicate: (s, i) => lane.adjudicateSameEvent(s, i, { ask: async () => ({ same: true }) }) });
  ok(adjMerge.attached === 1 && lane.allStories().length === 1, 'the adjudicator MERGES the ambiguous cross-source pair into ONE story');

  // ===== CROSS-MODAL GATE: a video (broadcast CC) segment must be adjudicator-CONFIRMED to merge into a wire story =====
  clearStories(); newsdb.get().exec('DELETE FROM news_story_updates');
  const rssIran = { id: 501, source: 'Reuters', source_kind: 'rss', title: 'US and Iran clash over Strait of Hormuz shipping lanes', summary: 'Tensions rise.', ts: NOW };
  const vidIran = { source: 'CNN', source_kind: 'video', title: 'US and Iran clash over Strait of Hormuz shipping lanes', summary: 'Broadcast segment.', ts: NOW };
  await lane.clusterItems([rssIran], { now: NOW });
  const g1 = await lane.clusterItems([{ ...vidIran, id: 502 }], { now: NOW });   // identical headline (high score) but NO adjudicator
  ok(g1.attached === 0 && lane.allStories().length === 2, 'video segment does NOT auto-attach to a wire story on score alone (gate → new when unconfirmed)');
  clearStories(); newsdb.get().exec('DELETE FROM news_story_updates');
  await lane.clusterItems([rssIran], { now: NOW });
  const g2 = await lane.clusterItems([{ ...vidIran, id: 503 }], { now: NOW, adjudicate: async () => true });
  ok(g2.attached === 1 && lane.allStories().length === 1, 'video segment MERGES into the wire story when the adjudicator CONFIRMS (cross-modal corroboration)');
  clearStories(); newsdb.get().exec('DELETE FROM news_story_updates');

  // ===== ENTITY-BRIDGE: a differently-WORDED video segment merges via shared CANONICAL entities =====
  const wire = { id: 601, source: 'Reuters', source_kind: 'rss', title: 'US and Iran clash over Strait of Hormuz', summary: '', ts: NOW };
  const vidBridge = { source: 'CNN', source_kind: 'video', title: 'Oil Prices Spike on Gulf Tensions', summary: '', entities: ['Iran', 'Strait of Hormuz'], ts: NOW };  // NO headline-word overlap with the wire
  await lane.clusterItems([wire], { now: NOW });
  const yb = await lane.clusterItems([{ ...vidBridge, id: 602 }], { now: NOW, adjudicate: async () => true });
  ok(yb.attached === 1 && lane.allStories().length === 1, 'entity-bridge: a differently-worded video segment MERGES into the wire story via shared canonical entities (reaches adjudicator via the lowered video floor)');
  // control: the SAME differently-worded video WITHOUT the reconstructed entities scores below the floor → never reaches the adjudicator → stays separate (proves the entities are the bridge)
  clearStories(); newsdb.get().exec('DELETE FROM news_story_updates');
  await lane.clusterItems([wire], { now: NOW });
  const nb = await lane.clusterItems([{ ...vidBridge, id: 603, entities: undefined }], { now: NOW, adjudicate: async () => true });
  ok(nb.attached === 0 && lane.allStories().length === 2, 'control: without canonical entities the same video scores below the floor → no merge (the entities ARE the bridge)');
  clearStories(); newsdb.get().exec('DELETE FROM news_story_updates');

  // ===== NEWS TUNER: balanceStories / buildBriefing apply reserve+cap so a corroborated topic can't drown out =====
  const S = (category, oc, rc, title) => ({ title, category, outlet_count: oc, report_count: rc, last_ts: NOW });
  const pool = [
    S('sports', 8, 8, 'World Cup final recap'),   // genuinely highly-corroborated (NOT syndication) — would top a flat brief
    S('sports', 7, 7, 'Transfer news'),
    S('world', 3, 3, 'Ceasefire talks'),
    S('politics', 2, 2, 'Senate vote'),
    S('local', 1, 1, 'County budget'),
    S('health', 1, 1, 'Flu season update'),
  ];
  const flat = lane.balanceStories(pool, null, { top: 6 });          // no tuner → corroboration-first
  ok(flat[0].category === 'sports', 'no tuner: the most-corroborated (sports) leads — the drown-out problem');
  const tuner = require('../lib/news_rank').defaultTuner();
  const bal = lane.balanceStories(pool, tuner, { top: 6 });          // tuner → reserve hard-news + cap sports
  ok(tuner.categories[bal[0].category].protected === true, 'tuner: a PROTECTED hard-news category leads (reserved slot), not sports');
  ok(bal.filter(s => s.category === 'sports').length <= 2, 'tuner: sports is capped, cannot flood even when most-corroborated');
  const brief = lane.buildBriefing(pool, { top: 6, tuner });
  ok(/Ceasefire|Senate|County|Flu/.test(brief.split('\n')[0]), 'buildBriefing with tuner: hard news heads the briefing');

  // ===== FULL-ARTICLE INGESTION (worthy stories → web_extract → richer evidence doc) =====
  clearStories(); newsdb.get().exec('DELETE FROM news_story_updates'); newsdb.get().exec('DELETE FROM news_items');
  // near-identical (auto-continue S≥.60) but non-identical headlines from 2 outlets → ONE corroborated story (2 reports)
  const a1 = store.insertItem({ source: 'BBC', sourceKind: 'rss', urlOrGuid: 'https://www.bbc.com/news/kyiv-strike', title: 'At least 18 killed in most massive Russian attack on Kyiv', summary: 'A lede.', ts: T });
  const a2 = store.insertItem({ source: 'CNN', sourceKind: 'rss', urlOrGuid: 'https://www.cnn.com/kyiv-attack', title: 'At least 18 killed in most massive Russian attack on Kyiv city', summary: 'Another lede.', ts: T + 1 });
  const arows = store.recentItems({ limit: 10 });
  await lane.clusterItems([arows.find((r) => r.id === a1.id)], { now: NOW });
  await lane.clusterItems([arows.find((r) => r.id === a2.id)], { now: NOW });
  const artStory = lane.allStories()[0];
  ok(/^https?:\/\//.test(lane.representativeArticleUrl(artStory.id) || ''), 'representativeArticleUrl returns a direct RSS http article link');
  // fetchArticle parses web_extract clean text (mock dispatch); fail-soft on !ok / no url
  const AF = mkDispatchState();
  ok(/FULL ARTICLE/.test(await lane.fetchArticle({ dispatch: AF.dispatch, url: 'https://x/y' }) || ''), 'fetchArticle returns web_extract trafilatura clean text');
  ok((await lane.fetchArticle({ dispatch: async () => ({ ok: false }), url: 'x' })) === null, 'fetchArticle fail-soft → null on a failed extract');
  ok((await lane.fetchArticle({ dispatch: AF.dispatch, url: '' })) === null, 'fetchArticle → null with no URL');
  // JS-wall / paywall / bot-check guard: don't store the wall text as the article
  ok(lane.isJunkBody('Please enable JS and disable any ad blocker') === true, 'isJunkBody flags a JS/ad-blocker wall');
  ok(lane.isJunkBody('Verify you are a human to continue') === true, 'isJunkBody flags a bot-check page');
  ok(lane.isJunkBody('short') === true, 'isJunkBody flags a too-short body');
  ok(lane.isJunkBody('DEARBORN, Mich. (AP) — Police said there was a shooting at a shopping mall Friday, and several people were hurt in the incident that unfolded in the afternoon.') === false, 'isJunkBody passes a real article lede');
  const WALL = { dispatch: async () => ({ ok: true, text: JSON.stringify({ url: 'x', extractor: 'trafilatura', text_preview: 'Please enable JS and disable any ad blocker' }) }) };
  ok((await lane.fetchArticle({ dispatch: WALL.dispatch, url: 'https://paywalled.example/x' })) === null, 'fetchArticle → null when web_extract returns a JS-wall (not stored as the article)');
  // HOURLY readArticlesPass is the driver: reads the worthy story's article once + persists it
  const RA = mkDispatchState();
  const rap = await lane.readArticlesPass({ dispatch: RA.dispatch, now: NOW });
  ok(rap.read === 1 && RA.calls.web_extract.length === 1, 'readArticlesPass reads the worthy story’s article exactly once');
  ok(lane.allStories()[0].article_text && /FULL ARTICLE BODY/.test(lane.allStories()[0].article_text), 'the fetched article body is persisted on the story');
  // idempotent: a second hourly pass does NOT re-read an already-read story
  const RA2 = mkDispatchState();
  const rap2 = await lane.readArticlesPass({ dispatch: RA2.dispatch, now: NOW });
  ok(rap2.read === 0 && RA2.calls.web_extract.length === 0, 'idempotent: readArticlesPass does NOT re-read a story with a stored article');
  // promoteStory (nightly) does NOT fetch — it just INCLUDES the stored body in the evidence doc
  const AP = mkDispatchState();
  await lane.promoteStory(lane.allStories()[0], { dispatch: AP.dispatch, landDoc: AP.landDoc, now: NOW });
  ok(AP.calls.web_extract.length === 0, 'promoteStory does NOT fetch (reading is the hourly pass now)');
  ok(AP.calls.landDoc.some((d) => /## Full article/.test(d.body) && /FULL ARTICLE BODY/.test(d.body)), 'the evidence doc carries the stored full-article body');
  // a story with no fetchable URL (video/aggregator) → no read attempted, keeps summary doc
  clearStories(); newsdb.get().exec('DELETE FROM news_items');
  await lane.clusterItems([{ source: 'CNN', source_kind: 'video', title: 'Broadcast segment on Kyiv', summary: 'seg', ts: T }], { now: NOW });
  const vStory = lane.allStories()[0];
  ok(lane.representativeArticleUrl(vStory.id) === null, 'a video/aggregator story with no http article link → representativeArticleUrl null (keeps summary doc)');

  try { fs.unlinkSync(tmp); } catch {}
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
