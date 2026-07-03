/* Smoke: the NEWS → RECONCILE tie-in (reconciliation spec §7 — the news lane is the first PRODUCTION
 * consumer of lib/reconcile). Proves the story→Claim adapter shape, that reconcile.score() reproduces the
 * news lane's syndication-aware corroboration from the emitted citations, the hard citation invariant
 * (no citations → reconcile REJECTS → promoteStory skips), and the end-to-end append path. ISOLATED temp DB.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_news_claim.js */
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = path.join(os.tmpdir(), `sq_newsclaim_smoke_${process.pid}.db`);
try { fs.unlinkSync(tmp); } catch {}
process.env.NEWS_DB_PATH = tmp;

const newsdb = require('../lib/news_db');
const lane = require('../lib/news_lane');
const reconcile = require('../lib/reconcile');
lane.ensureSchema();

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const clearStories = () => { newsdb.get().exec('DELETE FROM news_stories'); newsdb.get().exec('DELETE FROM news_story_updates'); };

const T = 1_700_000_000_000;
const NOW = T + 10000;

// mocked Echo write surface (mirrors smoke_news_lane): every external write lands as a tenant proposal.
function mkDispatchState() {
  const calls = { propose_entity: [], promote_proposal: [], propose_relation: [], landDoc: [] };
  let pid = 100;
  const dispatch = async (tag) => {
    if (tag.name === 'propose_entity') { calls.propose_entity.push(tag.args); return { ok: true, text: JSON.stringify({ action: 'proposed', entity_id: ++pid }) }; }
    if (tag.name === 'promote_proposal') { calls.promote_proposal.push(tag.args); return { ok: true, text: JSON.stringify({ entity_id: Number(tag.args.proposal_id) + 4900 }) }; }
    if (tag.name === 'propose_relation') { calls.propose_relation.push(tag.args); return { ok: true, text: JSON.stringify({ action: 'created' }) }; }
    return { ok: false };
  };
  const landDoc = async (d) => { calls.landDoc.push(d); return { landed: true }; };
  return { dispatch, landDoc, calls };
}

(async () => {
  // ===== (1) storyToClaim shape =====
  clearStories();
  // an aggregator item → 3 independent outlets/reports (genuine corroboration)
  await lane.clusterItems([{ source: 'Google News', title: 'Kyiv attack kills 17', summary: 'A large strike on the capital.', members: [{ outlet: 'NBC', headline: 'Kyiv attack kills 17' }, { outlet: 'NYT', headline: 'Russia hammers Kyiv' }, { outlet: 'CNBC', headline: 'Deadly strike on Kyiv' }], ts: T }], { now: NOW });
  const story = lane.allStories()[0];
  const claim = lane.storyToClaim(story, { now: NOW });
  ok(claim.kind === 'event' && claim.lane === 'news' && claim.provenance === 'read', 'storyToClaim → Claim{kind:event, lane:news, provenance:read}');
  ok(claim.subject && claim.subject.name === story.title && claim.subject.type === 'event', 'claim.subject names the story as an event');
  ok(Array.isArray(claim.citations) && claim.citations.length > 0, 'claim carries citations (>=1)');
  ok(claim.citations.every((c) => c.authority_tier === 2), 'news citations default to authority_tier 2 (major outlet)');

  // ===== (2) reconcile.score() reproduces the news lane's corroboration from the emitted citations =====
  const sc = reconcile.score(claim.citations);
  ok(sc.reports === (story.report_set instanceof Set ? story.report_set.size : story.report_count), `score.reports (${sc.reports}) == story report_count (${story.report_count}) — syndication-aware count survives the round-trip`);
  ok(sc.outlets === (story.outlet_set instanceof Set ? story.outlet_set.size : story.outlet_count), `score.outlets (${sc.outlets}) == story outlet_count (${story.outlet_count})`);
  ok(sc.tier === 'corroborated', 'a 3-report story scores tier=corroborated (shared math)');

  // ===== (3) reconcile decision for a citationed event = APPEND (events cluster, never supersede) =====
  const dec = reconcile.reconcile(claim, null, { resolution: 'nil', now: NOW });
  ok(dec.action === 'append', 'reconcile(event-claim, null) → append (the news write decision)');

  // ===== (4) THE CITATION INVARIANT: a story with no reports/outlets → reject → promoteStory skips =====
  const emptyStory = { id: 999, title: 'Uncorroborated rumor', summary: 'One anonymous post.', report_set: new Set(), outlet_set: new Set(), source_set: new Set(), last_ts: NOW };
  const emptyClaim = lane.storyToClaim(emptyStory, { now: NOW });
  ok(emptyClaim.citations.length === 0, 'a story with empty report/outlet sets emits ZERO citations');
  const rej = reconcile.reconcile(emptyClaim, null, { resolution: 'nil', now: NOW });
  ok(rej.action === 'reject' && rej.reason === 'no-citation', 'reconcile REJECTS a citation-less claim (nothing enters long-term without a citation)');
  const G = mkDispatchState();
  const gRes = await lane.promoteStory(emptyStory, { dispatch: G.dispatch, landDoc: G.landDoc, now: NOW });
  ok(gRes.decision === 'reject' && gRes.event === false && gRes.doc === false, 'promoteStory HONORS the reconcile reject: no event proposed, no doc landed');
  ok(G.calls.propose_entity.length === 0 && G.calls.landDoc.length === 0, 'reconcile-rejected story makes ZERO Echo writes (the gate fires before any side effect)');

  // ===== (5) end-to-end: the corroborated story still promotes through the gate (no regression) =====
  const P = mkDispatchState();
  const rp = await lane.promoteStory(story, { dispatch: P.dispatch, landDoc: P.landDoc, now: NOW });
  ok(rp.decision === 'append' && rp.event === true && rp.doc === true, 'the corroborated story passes the gate (decision=append) and promotes as before');
  ok(P.calls.propose_entity.length === 1 && P.calls.propose_entity[0].entity_type === 'event', 'the worthy story is still proposed as an event object');

  // ===== (6) runDailyPass surfaces a reconcile-rejected tally =====
  // storiesForDaily pre-filters corroboration>=2, so a real pass rejects nothing — the tally exists + is 0.
  clearStories();
  await lane.clusterItems([{ source: 'Google News', title: 'Senate passes the budget', summary: 'The chamber voted.', members: [{ outlet: 'AP', headline: 'Senate passes budget' }, { outlet: 'Reuters', headline: 'Budget clears Senate' }], ts: T }], { now: NOW });
  const DP = mkDispatchState();
  const daily = await lane.runDailyPass({ dispatch: DP.dispatch, landDoc: DP.landDoc, now: NOW });
  ok(typeof daily.rejected === 'number' && daily.rejected === 0, 'runDailyPass reports a reconcile-rejected tally (0 for pre-filtered worthy stories)');
  ok(daily.promoted === 1, 'runDailyPass still promotes the worthy story end-to-end (append path intact)');

  try { fs.unlinkSync(tmp); } catch {}
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
