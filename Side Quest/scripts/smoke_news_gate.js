/* Smoke: S3b-remainder for the NEWS lane (lib/news_lane.promoteStory). A news LINKED_TO edge's TARGET
 * (a principal) is routed through the SAME node-resolution gate the [grow] lane uses (preResolve:
 * civic_canon → block→match→canonical) BEFORE proposing. The representative win: a CIVIC HUB body that news
 * constantly names ("United States Senate", "Treasury", "Supreme Court") resolves to its ONE canonical
 * Echo node ("United States Senate [wd:Q66096]") instead of rejecting on a surface-form miss and re-minting
 * a duplicate hub. A bare person name (first+last, no id/jurisdiction) correctly STAYS RAW — the matcher's
 * anti-fan precision guard holds it (never a false merge), so the edge lands under the raw name exactly as
 * before. The SOURCE (story.title, the freshly-created event node) is always left raw.
 *
 * Fully offline: a mock `dispatch` plays Echo — search_entities surfaces the canonical Senate node (by the
 * canon-stamped strong id) and captures every propose_relation. The story carries event_ref so promoteStory
 * skips event creation and goes straight to the gated edge loop.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_news_gate.js
 */
'use strict';
const news = require('../lib/news_lane');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

(async () => {
  const proposed = [];   // captured propose_relation args
  const searched = [];   // captured search_entities queries

  // Mock Echo: the gate's live deps + the edge write both flow through this one dispatch.
  const dispatch = async (t) => {
    const name = t && t.name;
    const args = (t && t.args) || {};
    if (name === 'search_entities') {
      const q = String(args.query || '').toLowerCase();
      searched.push(q);
      // The Senate hub surfaces by its canon-stamped strong id (Q66096) OR its name key; nothing else does.
      if (q.includes('senate') || q.includes('q66096')) {
        return { ok: true, isError: false, text: JSON.stringify([{ id: 1631718, name: 'United States Senate [wd:Q66096]', entity_type: 'organization', degree: 500 }]) };
      }
      return { ok: true, isError: false, text: JSON.stringify([]) };
    }
    if (name === 'propose_relation') {
      proposed.push({ source: args.source_name, target: args.target_name, type: args.relation_type });
      return { ok: true, isError: false, text: JSON.stringify({ action: 'created' }) };
    }
    // any other tool (set_entity_temporal etc.) — benign ok
    return { ok: true, isError: false, text: '{}' };
  };

  // event_ref set → skip event creation; outlet_set non-empty → reconcile('event') = append → reach edges.
  const story = {
    id: 4242,
    title: 'Lawmakers advance funding measure',
    summary: 'Leaders said the United States Senate advanced the plan; opponent Random Unknownperson objected.',
    event_ref: '999',
    outlet_set: ['Reuters', 'AP'],
    report_set: [],
    report_count: 2,
    first_ts: 1700000000000,
    article_url: 'https://reuters.com/x',
    category: 'politics',
  };

  // NO landDoc, NO extract → doc-land + concept-mint are skipped; the edge loop is what we exercise.
  const res = await news.promoteStory(story, { dispatch, now: 1700000100000, maxEdges: 10 });

  ok(res && res.edges >= 1, `promoteStory reached the edge loop and landed ≥1 edge (edges=${res && res.edges})`);
  ok(searched.length >= 1, 'the gate was invoked on the principals (search_entities called)');

  const senEdge = proposed.find((e) => /senate/i.test(String(e.target)));
  ok(!!senEdge, 'a LINKED_TO edge targets the Senate principal');
  ok(senEdge && senEdge.target === 'United States Senate [wd:Q66096]',
    `the civic-hub principal's target_name was SWAPPED to the canonical QID node (got: ${senEdge && senEdge.target})`);

  const rawEdge = proposed.find((e) => String(e.target) === 'Random Unknownperson');
  ok(!!rawEdge, 'a bare person name stays RAW — anti-fan hold, no false merge (behavior preserved)');

  ok(proposed.every((e) => e.source === 'Lawmakers advance funding measure'),
    'the SOURCE (story.title / event node) is always left raw — never gate-resolved');
  ok(proposed.every((e) => e.type === 'LINKED_TO'), 'every proposed edge is the whitelisted LINKED_TO type');

  // No-dispatch safety: gate deps null → canonResolve inert → never throws (fresh-install / offline).
  const res2 = await news.promoteStory({ ...story, id: 4243 }, { dispatch: null, now: 1700000100000 }).catch((e) => ({ threw: e.message }));
  ok(res2 && !res2.threw, 'promoteStory with no dispatch does not throw (gate inert, fail-soft)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
