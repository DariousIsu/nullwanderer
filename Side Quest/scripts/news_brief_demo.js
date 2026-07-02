/* DEMO (not a gate): run REAL feed items (pulled live 2026-07-02) through the reservoir → compression →
 * news brief, so we can see the pipeline + the brief template on actual news. Shows: clustered stories,
 * the deterministic FALLBACK brief, the grounded CLOUD INPUT, and the exact INSTRUCTIONS the cloud fills.
 * Also writes the cloud input to a temp file + supports `render <briefJson>` to render a cloud-produced
 * JSON with the same input (so we can eyeball a real cloud fill). ISOLATED temp DB.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/news_brief_demo.js
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/news_brief_demo.js render <briefJson>
 */
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(os.tmpdir(), `sq_newsdemo_${process.pid}.db`);
try { fs.unlinkSync(tmpDb); } catch {}
process.env.NEWS_DB_PATH = tmpDb;

const store = require('../lib/news_store');
const lane = require('../lib/news_lane'); lane.ensureSchema();
const brief = require('../lib/news_brief');

const INPUT_FILE = path.join(os.tmpdir(), 'sq_news_brief_input.json');
const B = 1751457600000;                 // fixed base ms
const m = (min) => B + min * 60000;      // minutes → ms (keeps all items inside the 6h open window)
const NOW = m(300);

// REAL items (LIVE fetch 2026-07-02, most recent snapshot). Google News items carry their real member
// outlets (the aggregator pre-cluster) so outlet corroboration is genuine.
const GN = 'https://news.google.com/rss';
const ITEMS = [
  // Google News aggregator clusters — each lists its real member outlets (distinct corroboration)
  { source: 'Google News', sourceUrl: GN, id: 'gn-kyiv', title: "Russian attacks kill at least 18, injure scores in Kyiv after Zelenskyy warned of 'massive strike'", summary: 'Russia hit Kyiv with a large drone-and-missile assault; reported death tolls range from 13 to 20 across outlets, and Russia said it will keep increasing pressure on the capital.', publishedMs: m(200), members: [{ outlet: 'NBC News' }, { outlet: 'The New York Times' }, { outlet: 'The Washington Post' }, { outlet: 'CNBC' }, { outlet: 'Reuters' }] },
  { source: 'Google News', sourceUrl: GN, id: 'gn-trump-wealth', title: "Trump's wealth grew on a scale without modern presidential precedent", summary: 'Coverage of the president\'s finances notes he made about $1.4 billion from crypto last year, drawing scrutiny over conflicts of interest.', publishedMs: m(40), members: [{ outlet: 'The Washington Post' }, { outlet: 'The New York Times' }, { outlet: 'CNN' }, { outlet: 'The Hill' }] },
  { source: 'Google News', sourceUrl: GN, id: 'gn-scotus-trans', title: 'SCOTUS ruling on transgender athletes in women’s sports draws state and NCAA response', summary: 'After the Supreme Court ruling, the NCAA said it has no plan to change its rules and officials including California’s governor responded.', publishedMs: m(150), members: [{ outlet: 'Fox News' }, { outlet: 'The New York Times' }, { outlet: 'CBS News' }, { outlet: 'The Washington Post' }, { outlet: 'The New Yorker' }] },
  { source: 'Google News', sourceUrl: GN, id: 'gn-birthright', title: "Trump administration eyes 'birth tourism' crackdown after Supreme Court birthright ruling", summary: 'Following a Supreme Court setback on birthright citizenship, the administration is weighing steps targeting so-called birth tourism.', publishedMs: m(80), members: [{ outlet: 'Axios' }, { outlet: 'WSJ' }, { outlet: 'The Guardian' }, { outlet: 'CNN' }, { outlet: 'SCOTUSblog' }] },
  { source: 'Google News', sourceUrl: GN, id: 'gn-venezuela', title: 'Rescuers pull survivor from rubble eight days after devastating Venezuela earthquakes', summary: 'Rescuers freed a survivor eight days after the quakes; nearly 50,000 remain unaccounted for as the death toll climbs.', publishedMs: m(180), members: [{ outlet: 'BBC' }, { outlet: 'CNN' }, { outlet: 'Yahoo' }, { outlet: 'World Central Kitchen' }, { outlet: 'CBC' }] },
  // BBC (plain feed)
  { source: 'BBC News', sourceUrl: 'bbc', id: 'bbc-kyiv', title: "'Most massive' Russian attack on Kyiv kills at least 20", summary: "Kyiv's mayor declares a day of mourning after the major drone and missile attack on the Ukrainian capital.", publishedMs: m(190) },
  { source: 'BBC News', sourceUrl: 'bbc', id: 'bbc-china-plane', title: "China says pilot crashed small plane into skyscraper for 'personal reasons'", summary: 'The 66-year-old, who died in the crash, had anxiety and referenced ending his life in his diary.', publishedMs: m(120) },
  { source: 'BBC News', sourceUrl: 'bbc', id: 'bbc-rabies', title: 'Canadian boy, 11, dies of rabies after waking to bat on his face', summary: 'Rabies infections are rare in Canada; there have been 28 human deaths since 1924.', publishedMs: m(10) },
  // The Hill (plain feed) — an Iran/Hormuz thread + a product recall
  { source: 'TheHill.com', sourceUrl: 'hill', id: 'hill-iran-senate', title: 'Senate votes to halt Iran war, then flips', summary: 'The Senate voted for and against ending the war with Iran on consecutive days, with Trump lashing out at four GOP senators who backed the war-powers resolution.', publishedMs: m(260) },
  { source: 'TheHill.com', sourceUrl: 'hill', id: 'hill-iran-hormuz', title: "Iran warns of 'forceful response' if tankers don't use approved Strait of Hormuz routes", summary: "Iran's joint military command warned of a forceful response if tankers passing through the Strait of Hormuz do not follow approved routes.", publishedMs: m(250) },
  { source: 'TheHill.com', sourceUrl: 'hill', id: 'hill-chips', title: "Potato chip recall elevated to FDA's highest risk level", summary: 'Consumers are advised to discard affected Zapp\'s products and contact Utz for refunds.', publishedMs: m(255) },
];

function compress() {
  for (const it of ITEMS) { const row = store.fromFeedItem(it, { sourceKind: it.sourceUrl.includes('google') ? 'aggregator' : 'rss' }); if (row) store.insertItem(row, NOW); }
  const rows = store.recentItems({ limit: 100 }).slice().reverse();   // oldest-first for clustering
  return lane.clusterItems(rows, { now: NOW });
}

async function main() {
  await compress();
  const stories = lane.storiesActiveInWindow(0);
  const deltasByStory = {}; for (const s of stories) deltasByStory[s.id] = lane.storyDeltas(s.id);
  const input = brief.briefInput(stories, { deltasByStory });
  fs.writeFileSync(INPUT_FILE, JSON.stringify(input, null, 2));

  console.log(`\n================ CLUSTERED STORIES (${stories.length}) — with CONFIRMATION ================`);
  for (const s of stories.sort((a, b) => (b.outlet_count - a.outlet_count) || (b.update_count - a.update_count))) {
    const c = lane.storyConfirmation(s);
    console.log(`• ${s.title}\n    outlets(${c.outletCount}): ${[...s.outlet_set].join(', ')}  |  ${c.tier}${s.update_count > 1 ? '  · DEVELOPING' : ''}${c.redaction ? '  · ⚠REDACTION' : ''}`);
  }

  console.log('\n================ FALLBACK BRIEF (deterministic, no cloud) ================\n');
  console.log(brief.renderBrief(brief.fallbackBrief(input), input, { windowLabel: 'the last few hours', nowIso: '2026-07-02T13:00:00Z' }));

  console.log('\n================ CLOUD INPUT (grounded — what the model fills from) ================\n');
  console.log(JSON.stringify(input.map(s => ({ id: s.id, headline: s.headline, outlets: s.outlets, corroboration: s.corroboration || 'single-source', redaction: s.redaction, snippet: s.snippet })), null, 2));

  console.log('\n================ INSTRUCTIONS (SYSTEM) ================\n');
  console.log(brief.SYSTEM);
  console.log('\n================ CONTRACT (want) ================\n');
  console.log(brief.briefWant());
  console.log(`\n(cloud input written to ${INPUT_FILE} — to render a cloud fill: news_brief_demo.js render <briefJson>)`);
}

async function renderMode(briefPath) {
  const input = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  const b = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
  console.log('\n================ CLOUD-FILLED BRIEF (rendered) ================\n');
  console.log(brief.renderBrief(b, input, { windowLabel: 'the last few hours', nowIso: '2026-07-02T13:00:00Z' }));
}

(async () => {
  try {
    if (process.argv[2] === 'render' && process.argv[3]) await renderMode(process.argv[3]);
    else await main();
  } catch (e) { console.error('demo failed:', e); process.exitCode = 1; }
  finally { try { fs.unlinkSync(tmpDb); } catch {} }
})();
