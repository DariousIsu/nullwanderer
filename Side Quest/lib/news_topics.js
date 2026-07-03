/*
 * lib/news_topics.js — the News Tuner's CATEGORY MODEL (design: docs/NEWS_TUNER_DESIGN.md, slice 1).
 *
 * A shared 9-category taxonomy for topical balance across the scrolling feed AND the brief. UMD so it runs
 * in Node (collector/compression) AND the browser (the Monitors widget), like studio/feeds_view.
 *
 * Classification is CLOUD-ON-EVERYTHING (Lucas): every item/story is cloud-classified ONCE and the verdict
 * cached on its row — never re-classified (the cost control). `categorizeFast` is the free deterministic
 * label shown provisionally until the cloud verdict lands, and the fail-safe when cloud is down. Mirrors the
 * ad-filter's batched+validated+fail-safe shape (lib/news_ads).
 *
 * Weather is its own PROTECTED, UNCAPPED category (hurricanes/wildfires are hard news you never cap).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.NewsTopics = api;
})(this, function () {
  'use strict';

  const str = (s) => String(s == null ? '' : s);

  // The fixed taxonomy. `protected` = counts toward the brief/feed's reserved hard-news slots. Order is the
  // canonical display order. Lexicons drive `categorizeFast`; the cloud sees the labels + hints.
  const TAXONOMY = [
    { key: 'world',    label: 'World & Conflict',   protected: true,
      kw: ['war','ceasefire','airstrike','missile','invasion','troops','nato','united nations',' u.n.','sanctions','refugee','coup','diplomat','foreign minister','gaza','ukraine','russia','kyiv','israel','iran','beijing','border clash','hostage','embassy','summit','treaty'] },
    { key: 'politics', label: 'US Politics & Gov',  protected: true,
      kw: ['election','senate','congress','house of representatives','white house','president','governor','campaign','ballot','legislation','the bill','supreme court','justices','impeach','primary','democrat','republican','gop','cabinet','nominee','filibuster','capitol','federal judge','executive order'] },
    { key: 'local',    label: 'Local & Civic',      protected: true,
      kw: ['city council','county commission','board of supervisors','school district','zoning','ordinance','township','borough','sheriff','city hall','municipal','county board','planning commission','local officials','residents'] },
    { key: 'markets',  label: 'Business & Markets', protected: true,
      kw: ['stock','shares','nasdaq','dow jones','s&p 500','earnings','ipo','federal reserve','interest rate','inflation','gdp','treasury','bond','bitcoin','crypto','merger','acquisition','quarterly','revenue','layoffs','wall street','market'] },
    { key: 'health',   label: 'Health & Science',   protected: true,
      kw: ['cdc','fda','outbreak','virus','vaccine','disease','hospital','patients','study finds','researchers','clinical trial','cancer','diabetes','mental health','world health','epidemic','symptoms','drug approval','infection','parasite'] },
    { key: 'weather',  label: 'Weather & Disaster', protected: true,
      kw: ['hurricane','tropical storm','tornado','wildfire','flood','blizzard','heat wave','drought','storm surge','evacuat','forecast','snowfall','cold snap','meteorolog','cyclone','typhoon','earthquake','landslide','severe weather','national weather service'] },
    { key: 'tech',     label: 'Technology',         protected: false,
      kw: ['artificial intelligence',' ai ','chatgpt','openai','software','the app','chipmaker','semiconductor','startup','cybersecurity','data breach','algorithm','smartphone','cloud computing','robot','quantum','silicon valley'] },
    { key: 'sports',   label: 'Sports',             protected: false,
      kw: ['world cup','fifa','uefa','premier league','nba','nfl','mlb','nhl','playoff','the match','scored','striker','touchdown','quarterback','olympics','tennis','pga','formula 1',' f1 ','grand prix','championship','tournament','head coach','roster','the finals','round of 16'] },
    { key: 'culture',  label: 'Culture & Other',    protected: false,
      kw: ['movie','the film','music','celebrity','album','tv show','entertainment','the art','the book','fashion','red carpet','box office','festival','streaming series','grammy','oscar'] },
  ];
  const CATEGORIES = TAXONOMY.map((t) => t.key);
  const BY_KEY = Object.fromEntries(TAXONOMY.map((t) => [t.key, t]));
  const LABEL_TO_KEY = Object.fromEntries(TAXONOMY.map((t) => [t.label.toLowerCase(), t.key]));

  // Source-name / host hints — a single-topic feed is a strong prior even when the headline is terse.
  const SOURCE_HINTS = [
    [/espn|sports|athletic|bleacher|fifa|goal\.com/i, 'sports'],
    [/weather\.gov|nws|accuweather|hurricane|storm\b/i, 'weather'],
    [/bloomberg|cnbc|marketwatch|barron|wall street|forbes|business insider|financ/i, 'markets'],
    [/politico|the hill|roll call|congress|\.house\.gov|\.senate\.gov|fec\b/i, 'politics'],
    [/legistar|granicus|civicplus|county|\.gov\b.*(council|commission)|city of /i, 'local'],
    [/techcrunch|the verge|wired|ars technica|engadget/i, 'tech'],
    [/cdc\b|fda\b|nih\b|who\b|medpage|stat news|health/i, 'health'],
  ];

  // FREE deterministic classify → { category, confidence }. Keyword hits (title+summary) plus a source-hint
  // bonus; highest wins; nothing → 'culture' at confidence 0 (the catch-all, unprotected). Provisional label
  // + cloud-down fail-safe. NOT the primary path (cloud is) — deliberately simple.
  function categorizeFast(item) {
    const it = item || {};
    const hay = (' ' + str(it.title) + ' ' + str(it.summary) + ' ').toLowerCase();
    const scores = {};
    for (const t of TAXONOMY) {
      let n = 0;
      for (const w of t.kw) if (hay.indexOf(w) !== -1) n++;
      if (n) scores[t.key] = n;
    }
    const srcHay = (str(it.source) + ' ' + str(it.sourceUrl)).toLowerCase();
    for (const [re, cat] of SOURCE_HINTS) if (re.test(srcHay)) scores[cat] = (scores[cat] || 0) + 1.5;
    let best = null, bestN = 0;
    for (const k of CATEGORIES) if ((scores[k] || 0) > bestN) { bestN = scores[k]; best = k; }
    return { category: best || 'culture', confidence: best ? Math.min(1, bestN / 3) : 0 };
  }

  // Coerce a model-returned category string to a valid key (accepts key OR label, case-insensitive). null if unknown.
  function toKey(cat) {
    const c = str(cat).toLowerCase().trim();
    if (BY_KEY[c]) return c;
    if (LABEL_TO_KEY[c]) return LABEL_TO_KEY[c];
    return null;
  }

  function classifyInput(items) {
    return (items || []).map((s) => ({ id: s.id, text: (str(s.title) + ' — ' + str(s.summary)).replace(/\s+/g, ' ').slice(0, 240) }));
  }
  const CLASSIFY_WANT = `You are labeling news headlines with ONE topic category. Categories (use the KEY):
- world: foreign affairs, war/conflict, international
- politics: US politics, elections, Congress, courts, government
- local: city/county/civic government, local community news
- markets: business, economy, stocks, companies, finance
- health: health, medicine, science, disease, research
- weather: weather events + natural disasters (hurricanes, wildfires, floods, quakes)
- tech: technology, AI, software, gadgets
- sports: any sport, teams, matches, tournaments
- culture: entertainment, arts, celebrity, lifestyle, anything else
For EACH input id, output your best single category KEY. Respond with ONLY a JSON array, one per id:
[{"id": <id>, "cat": "<key>"}]`;
  // Extract each {"id":N,"cat":"key"} by regex (tolerates code fences / prose / truncation, like the ad-filter).
  function classifyValidator(raw) {
    const s = str(raw);
    const out = []; const re = /\{\s*"id"\s*:\s*"?(\d+)"?\s*,\s*"cat"\s*:\s*"([a-z ]+)"\s*\}/gi; let m;
    while ((m = re.exec(s)) !== null) { const k = toKey(m[2]); if (k) out.push({ id: Number(m[1]), cat: k }); }
    return out.length ? { valid: true, value: out } : { valid: false, error: 'no {id, cat} verdicts found' };
  }

  // CLOUD-ON-EVERYTHING: classify a batch of items → { [id]: category-key }. Every item goes to the model;
  // any the model omits/garbles falls back to categorizeFast (never unlabeled). deps.ask = cloud_logic.ask.
  // The CALLER batches (passes only NEW items per tick — each item is classified once, then cached).
  async function classifyTopicsBatch(items, { ask = null, model = null, numPredict = 1600 } = {}) {
    const verdict = {};
    if ((items || []).length && typeof ask === 'function') {
      try {
        const r = await ask({ task: 'news_topic_classify', v: 1, input: classifyInput(items), want: CLASSIFY_WANT, validate: classifyValidator, model, numPredict });
        if (Array.isArray(r)) for (const e of r) if (e && e.id != null && e.cat) verdict[e.id] = e.cat;
      } catch { /* fall through to fast */ }
    }
    for (const s of (items || [])) if (!verdict[s.id]) verdict[s.id] = categorizeFast(s).category;   // fail-safe / cloud-down
    return verdict;
  }

  return { TAXONOMY, CATEGORIES, BY_KEY, SOURCE_HINTS, categorizeFast, toKey, classifyInput, classifyValidator, CLASSIFY_WANT, classifyTopicsBatch };
});
