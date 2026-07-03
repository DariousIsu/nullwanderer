/**
 * lib/news_lane.js — the Data-Stream Lane COMPRESSION heart (design §"Mode 2 — ORGANIZE").
 *
 * The hourly pass turns the raw per-source reservoir into clean, clustered ROLLING STORIES:
 *   Stage 1 — per-source normalize (video: dedupe growing captions + strip ads; RSS: collapse
 *             top-of-hour repeats; aggregator: parse the <ol> into member {outlet,headline}).
 *   Stage 1b— aggregator items become pre-clusters that seed Stage 2.
 *   Stage 2 — cluster items into the persistent `news_stories` registry: attach to an OPEN story
 *             (continuation) or open a new one, keyed by S = 0.6·entityJaccard + 0.4·headlineJaccard
 *             (bands: ≥.60 continue / <.30 new / middle → injected model adjudication).
 *   Layer   — write a `news_layers` row (a deterministic hourly briefing over the touched stories).
 *
 * Rolling stories PERSIST across hourly layers (they are not re-clustered each hour); this is what
 * collapses broadcast top-of-hour repeats + wire re-runs into ONE story (→ one Echo `event` at the
 * daily pass, a later slice). Owns its own `news_stories`/`news_layers` schema (fold into db.js
 * MIGRATIONS at integration). Pure helpers are exported + unit-tested; async ops take injected deps.
 */
'use strict';
const newsdb = require('./news_db');
const { extractProperNouns } = require('./graph_walk');

// --- pure text helpers -------------------------------------------------------
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'as', 'by', 'from', 'that', 'this', 'these', 'those', 'is', 'are', 'was', 'were', 'be', 'been', 'has', 'have', 'had', 'will', 'new', 'over', 'after', 'says', 'said', 'most', 'least', 'into', 'about', 'more', 'than', 'amid', 'his', 'her', 'their', 'its']);
const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
const stripHtml = (s) => String(s == null ? '' : s).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

function tokenSet(text, minLen = 4) {
  return new Set(norm(text).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= minLen && !STOP.has(w)));
}
// Principal entities of an item = proper-noun tokens from title+summary (reuses graph_walk's extractor).
function entitySet(item) {
  const text = `${(item && item.title) || ''}. ${(item && item.summary) || ''}`;
  const s = new Set();
  for (const name of extractProperNouns(text)) {
    for (const w of norm(name).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)) {
      if (w.length >= 3 && !STOP.has(w)) s.add(w);
    }
  }
  return s;
}
function jaccard(a, b) {
  if (!a || !b || !a.size || !b.size) return 0;
  let inter = 0; for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
// The continuation score between two {entities, title} signatures. Entities dominate (0.6) over
// headline wording (0.4) — same principals matters more than shared words.
function continuationScore(A, B) {
  return 0.6 * jaccard(A.entities, B.entities) + 0.4 * jaccard(A.title, B.title);
}
function classifyContinuation(s, { hi = 0.60, lo = 0.30 } = {}) {
  return s >= hi ? 'continue' : (s < lo ? 'new' : 'ambiguous');
}
function signatureOf(item) { return { entities: entitySet(item), title: tokenSet(item && item.title, 4) }; }

// --- Stage 1: per-source normalize (pure) -----------------------------------

// Aggregator (Google News) summary <ol> → [{outlet, headline}]. Pre-cluster + corroboration seed.
function parseAggregatorMembers(summaryHtml) {
  const out = []; const s = String(summaryHtml || '');
  const liRe = /<li>([\s\S]*?)<\/li>/gi; let m;
  while ((m = liRe.exec(s)) !== null) {
    const li = m[1];
    const headline = stripHtml((li.match(/<a[^>]*>([\s\S]*?)<\/a>/i) || [])[1] || '');
    const outlet = stripHtml((li.match(/<font[^>]*>([\s\S]*?)<\/font>/i) || [])[1] || '');
    if (headline) out.push({ outlet: outlet || null, headline });
  }
  return out;
}

// YouTube captions grow incrementally (the window re-renders an extending line). Collapse each growing
// run to its settled longest form. (Proven live in the probe: "surprise repairs…" → "…Fast, affordable"
// → "…award-winning".) Pure.
function dedupeGrowingCaptions(lines) {
  // Compare case-insensitively but PRESERVE original case in the output — downstream entity extraction
  // needs the capitalization of proper nouns.
  const arr = (Array.isArray(lines) ? lines : []).map((s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim()).filter(Boolean);
  const low = arr.map((s) => s.toLowerCase());
  const out = [], outLow = [];
  for (let i = 0; i < arr.length; i++) {
    const curL = low[i], nextL = low[i + 1];
    if (nextL && nextL.includes(curL)) continue;                     // fragment of the next (still growing)
    if (outLow.length && curL.includes(outLow[outLow.length - 1])) { out[out.length - 1] = arr[i]; outLow[outLow.length - 1] = curL; continue; } // extends prev
    if (outLow.length && outLow[outLow.length - 1] === curL) continue; // exact repeat
    out.push(arr[i]); outLow.push(curL);
  }
  return out;
}

// FIRST-CUT ad detection from caption text alone (design §8.7 — heuristics-first; robust ad detection
// likely needs structural/segmentation cues, flagged). Catches the obvious CTA/promo lines.
const AD_RE = [/\bvisit\s+\S*\.(com|net|org)/i, /\b\d{1,3}%\s*off\b/i, /\bshop[\w.-]*\.com/i, /\bpromo code\b/i, /\bterms (and|&) conditions\b/i, /\bcall\s+1[-\s]?800/i, /\bsubscribe (now|today)\b/i, /\blimited time offer\b/i];
function isAdLine(line) { const t = norm(line); return AD_RE.some((re) => re.test(t)); }
function stripAdLines(lines) { return (Array.isArray(lines) ? lines : []).filter((l) => !isAdLine(l)); }

// Top-of-hour repeat collapse: within ONE source's hour, near-identical titles (headline loop) → keep
// the first (earliest). Pure; uses headline-token Jaccard ≥ 0.8.
function collapseRepeatedTitles(items, { thresh = 0.8 } = {}) {
  const kept = []; const keys = [];
  for (const it of (items || [])) {
    const k = tokenSet(it && it.title, 4);
    if (keys.some((s) => jaccard(s, k) >= thresh)) continue;
    keys.push(k); kept.push(it);
  }
  return kept;
}

// --- stories/layers schema + store ------------------------------------------
// --- confirmation: outlet corroboration + redaction signal (pure) ----------
// Distinct OUTLETS an item represents. Aggregators (Google News) list member outlets — one item can
// corroborate across ~5 outlets; a plain feed represents its own source. This is the real-world
// corroboration count (vs source_count = how many of OUR feeds carried it).
function outletsOf(item) {
  const out = [];
  let members = item && item.members;
  if (!members && item && item.summary && /<li>/i.test(item.summary)) members = parseAggregatorMembers(item.summary);
  if (Array.isArray(members) && members.length) for (const mm of members) { if (mm && mm.outlet) out.push(mm.outlet); }
  if (!out.length && item && item.source) out.push(item.source);
  // normalize + dedup (case-insensitive)
  const seen = new Set(), res = [];
  for (const o of out) { const k = String(o).toLowerCase().replace(/\s+/g, ' ').trim(); if (k && !seen.has(k)) { seen.add(k); res.push(displayClean(o)); } }
  return res;
}
// CORROBORATION must count INDEPENDENT reports, not outlet names — a wire story republished verbatim
// across N outlets (States Newsroom `/repub/`, Advance Local syndication; proven live: one Tim-Henderson
// labor story appeared identically across MO/OK/ND/AR/ME) is ONE report, not N. Report identity =
// normalized HEADLINE (syndicated copies share it verbatim → collapse across outlets). Aggregator members
// are genuinely-independent outlets (Google already clustered separate reporters) so each member counts.
// This keeps corroborationTier honest: 30 republished copies must NOT read as "widely reported".
const reportIdent = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
// A detected verbatim republication (not original reporting by its outlet). Confidence signal — the count
// relies on headline identity, but this marker is a clean positive (used for annotation/tuning).
function isSyndicatedRepublication(item) {
  const u = String((item && (item.url_or_guid || item.urlOrGuid)) || '');
  return /\/repub\//i.test(u) || /post_type=republished/i.test(u);
}
// The distinct independent-report keys this item contributes (→ union into the story's report_set).
function reportKeysOf(item) {
  const keys = [];
  let members = item && item.members;
  if (!members && item && item.summary && /<li>/i.test(item.summary)) members = parseAggregatorMembers(item.summary);
  if (Array.isArray(members) && members.length) {
    for (const m of members) { const k = reportIdent(m && (m.headline || m.outlet)); if (k) keys.push(k); }   // aggregator = independent outlets
  }
  if (!keys.length) { const k = reportIdent(item && item.title); if (k) keys.push(k); }                      // plain feed: headline identity (syndication collapses)
  return keys;
}
// A SOURCE-integrity signal (the outlet redacting/correcting ITS OWN reporting) — NOT subject-level
// "X denies"/"disputed", which are ordinary news. First-cut, textual; returns {kind, phrase} or null.
const REDACTION_RE = [
  { kind: 'retraction', re: /\b(retract(?:s|ed|ion)?|pulled (?:the )?(?:story|report|article)|withdr(?:ew|awn))\b/i },
  { kind: 'correction', re: /\b(correction|corrects\b|clarif(?:y|ies|ication)|editor'?s? note|updated to (?:remove|correct|clarify))\b/i },
];
function detectRedactionSignal(text) {
  const t = String(text || '');
  for (const { kind, re } of REDACTION_RE) { const m = t.match(re); if (m) return { kind, phrase: m[0] }; }
  return null;
}
// Corroboration tier from an outlet count. Tunable.
function corroborationTier(outletCount) {
  const n = Number(outletCount) || 0;
  return n >= 5 ? 'widely reported' : (n >= 2 ? 'corroborated' : 'single-source');
}

let _schemaReady = false;
function ensureSchema() {
  if (_schemaReady) return;
  newsdb.get().exec(`
    CREATE TABLE IF NOT EXISTS news_stories (
      id           INTEGER PRIMARY KEY,
      cluster_key  TEXT,
      title        TEXT,
      entity_set   TEXT,           -- JSON array of entity tokens
      source_set   TEXT,           -- JSON array of contributing sources
      source_count INTEGER NOT NULL DEFAULT 0,
      update_count INTEGER NOT NULL DEFAULT 1,   -- # of times touched; >1 = a DEVELOPING story
      outlet_set    TEXT,                         -- JSON array of distinct OUTLETS that carried it (REACH)
      outlet_count  INTEGER NOT NULL DEFAULT 0,
      report_set    TEXT,                         -- JSON array of distinct independent-report keys (CORROBORATION; syndication-collapsed)
      report_count  INTEGER NOT NULL DEFAULT 0,
      redaction     INTEGER NOT NULL DEFAULT 0,   -- a source issued a correction/retraction on this story
      redaction_note TEXT,
      first_ts     INTEGER NOT NULL,
      last_ts      INTEGER NOT NULL,
      summary      TEXT,
      event_ref    TEXT,           -- Echo entity id once promoted (idempotency key; daily pass)
      status       TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'closed'
      closed_at    INTEGER,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_news_stories_status ON news_stories(status, last_ts);
    CREATE TABLE IF NOT EXISTS news_story_updates (
      id        INTEGER PRIMARY KEY,
      story_id  INTEGER NOT NULL,
      ts        INTEGER NOT NULL,
      kind      TEXT NOT NULL,     -- 'born' | 'update'
      source    TEXT,
      title     TEXT,
      summary   TEXT,
      outlets   TEXT,              -- JSON array of outlets this update added
      signal    TEXT               -- redaction/correction kind if this update carried one
    );
    CREATE INDEX IF NOT EXISTS idx_news_story_updates_story ON news_story_updates(story_id, ts);
    CREATE TABLE IF NOT EXISTS news_layers (
      id           INTEGER PRIMARY KEY,
      hour_start   INTEGER NOT NULL,
      hour_end     INTEGER NOT NULL,
      briefing     TEXT,
      item_count   INTEGER NOT NULL DEFAULT 0,
      story_count  INTEGER NOT NULL DEFAULT 0,
      organized_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_news_layers_start ON news_layers(hour_start);
  `);
  // migration: add the syndication-aware corroboration columns to a pre-existing news_stories table.
  try {
    const cols = newsdb.get().prepare('PRAGMA table_info(news_stories)').all().map((c) => c.name);
    if (!cols.includes('report_set')) newsdb.get().exec('ALTER TABLE news_stories ADD COLUMN report_set TEXT');
    if (!cols.includes('report_count')) newsdb.get().exec('ALTER TABLE news_stories ADD COLUMN report_count INTEGER NOT NULL DEFAULT 0');
  } catch { /* fresh table already has the columns */ }
  _schemaReady = true;
}
const displayClean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();   // preserve CASE (entity extraction needs it), collapse whitespace only
const jparse = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };
function hydrateStory(r) {
  if (!r) return r;
  r.entity_set = new Set(jparse(r.entity_set, []));
  r.source_set = new Set(jparse(r.source_set, []));
  r.outlet_set = new Set(jparse(r.outlet_set, []));
  r.report_set = new Set(jparse(r.report_set, []));
  return r;
}

// Open stories whose last activity is within maxAgeMs (continuation only ever attaches to live stories).
function openStories({ now = Date.now(), maxAgeMs = 6 * 3600 * 1000 } = {}) {
  ensureSchema();
  return newsdb.get().prepare('SELECT * FROM news_stories WHERE status = ? AND last_ts >= ? ORDER BY last_ts DESC')
    .all('open', now - maxAgeMs).map(hydrateStory);
}
function createStory(item, sig, nowMs) {
  ensureSchema();
  const entities = [...sig.entities];
  const outlets = outletsOf(item);
  const reports = reportKeysOf(item);
  const redaction = detectRedactionSignal(`${item.title || ''}. ${item.summary || ''}`);
  const info = newsdb.get().prepare(
    `INSERT INTO news_stories (cluster_key, title, entity_set, source_set, source_count, outlet_set, outlet_count, report_set, report_count, redaction, redaction_note, first_ts, last_ts, summary, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
  ).run(entities.slice().sort().join(' '), displayClean(item.title) || '(untitled)', JSON.stringify(entities),
    JSON.stringify([item.source]), 1, JSON.stringify(outlets), outlets.length, JSON.stringify(reports), reports.length,
    redaction ? 1 : 0, redaction ? `${redaction.kind}: "${redaction.phrase}"` : null,
    item.ts || nowMs, item.ts || nowMs, displayClean(item.summary).slice(0, 500) || null, nowMs);
  if (item.id != null) newsdb.get().prepare('UPDATE news_items SET story_id = ? WHERE id = ?').run(info.lastInsertRowid, item.id);
  recordUpdate(info.lastInsertRowid, 'born', item, nowMs, { outlets, signal: redaction && redaction.kind });
  return info.lastInsertRowid;
}
function attachItem(story, item, sig, nowMs) {
  ensureSchema();
  const entities = new Set(story.entity_set); for (const e of sig.entities) entities.add(e);
  const sources = new Set(story.source_set); sources.add(item.source);
  const itemOutlets = outletsOf(item);
  const outlets = new Set(story.outlet_set || []); for (const o of itemOutlets) outlets.add(o);
  const reports = new Set(story.report_set || []); for (const k of reportKeysOf(item)) reports.add(k);   // syndication collapses (identical headline)
  const redaction = detectRedactionSignal(`${item.title || ''}. ${item.summary || ''}`);
  const lastTs = Math.max(story.last_ts, item.ts || nowMs);
  const nowRedacted = story.redaction ? 1 : (redaction ? 1 : 0);
  const note = story.redaction_note || (redaction ? `${redaction.kind}: "${redaction.phrase}"` : null);
  newsdb.get().prepare('UPDATE news_stories SET entity_set = ?, source_set = ?, source_count = ?, outlet_set = ?, outlet_count = ?, report_set = ?, report_count = ?, redaction = ?, redaction_note = ?, update_count = update_count + 1, last_ts = ? WHERE id = ?')
    .run(JSON.stringify([...entities]), JSON.stringify([...sources]), sources.size, JSON.stringify([...outlets]), outlets.size, JSON.stringify([...reports]), reports.size, nowRedacted, note, lastTs, story.id);
  if (item.id != null) newsdb.get().prepare('UPDATE news_items SET story_id = ? WHERE id = ?').run(story.id, item.id);
  recordUpdate(story.id, 'update', item, nowMs, { outlets: itemOutlets, signal: redaction && redaction.kind });
  // keep the in-memory story consistent for subsequent items in the same batch
  story.entity_set = entities; story.source_set = sources; story.source_count = sources.size;
  story.outlet_set = outlets; story.outlet_count = outlets.size; story.report_set = reports; story.report_count = reports.size;
  story.redaction = nowRedacted; story.redaction_note = note;
  story.last_ts = lastTs; story.update_count = (story.update_count || 1) + 1;
}
// The per-story delta log — records how a developing story evolved (born + each update, with the outlets
// it added + any correction/retraction signal). Read via storyDeltas(); formatted via formatDeltas().
function recordUpdate(storyId, kind, item, nowMs = Date.now(), { outlets = [], signal = null } = {}) {
  ensureSchema();
  newsdb.get().prepare('INSERT INTO news_story_updates (story_id, ts, kind, source, title, summary, outlets, signal) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(storyId, (item && item.ts) || nowMs, kind, (item && item.source) || null,
      displayClean(item && item.title) || null, displayClean(item && item.summary).slice(0, 300) || null,
      JSON.stringify(outlets || []), signal || null);
}
function storyDeltas(storyId, { limit = 50 } = {}) {
  ensureSchema();
  return newsdb.get().prepare('SELECT * FROM news_story_updates WHERE story_id = ? ORDER BY ts ASC, id ASC LIMIT ?').all(storyId, limit);
}
// Pure: a compact timeline of a developing story (born + updates), newest-last.
function formatDeltas(updates) {
  return (updates || []).map((u) => `${u.kind === 'born' ? '▸' : '•'} [${u.source || '?'}] ${u.title || ''}`.trim()).join('\n');
}
// # of distinct outlets that reported this story in updates since sinceMs (the "new outlets this hour"
// momentum signal).
function newOutletsSince(storyId, sinceMs) {
  ensureSchema();
  const rows = newsdb.get().prepare('SELECT outlets FROM news_story_updates WHERE story_id = ? AND ts >= ?').all(storyId, sinceMs);
  const s = new Set();
  for (const r of rows) for (const o of jparse(r.outlets, [])) s.add(String(o).toLowerCase());
  return s.size;
}
// The story's CONFIRMATION summary: corroboration (distinct outlets + tier) + integrity (redaction).
function storyConfirmation(story, { sinceMs = null } = {}) {
  const oc = Number(story.outlet_count) || (story.outlet_set instanceof Set ? story.outlet_set.size : 0);
  const rc = Number(story.report_count) || (story.report_set instanceof Set ? story.report_set.size : 0);
  // CORROBORATION is bounded by BOTH outlet diversity AND distinct reporting — min() defeats both
  // inflation directions: cross-outlet syndication (10 outlets / 1 headline → 1) AND single-outlet
  // multi-article clusters (1 outlet / 10 headlines → 1). Genuine 5-outlet/5-headline → 5.
  const corr = Math.min(oc, rc);
  return {
    corroborationCount: corr,      // independent corroboration = min(outlets, distinct reports) — DRIVES the tier
    reportCount: rc,               // distinct headlines (syndication-collapsed)
    outletCount: oc,               // REACH — distinct outlets that carried it (may exceed corroboration)
    syndicated: oc > corr && corr > 0, // reach exceeds independent corroboration (republished / single-outlet spread)
    tier: corroborationTier(corr),
    redaction: !!story.redaction,
    redactionNote: story.redaction_note || null,
    newOutlets: sinceMs != null ? newOutletsSince(story.id, sinceMs) : null,
  };
}
function closeStaleStories({ now = Date.now(), coldMs = 6 * 3600 * 1000 } = {}) {
  ensureSchema();
  return newsdb.get().prepare("UPDATE news_stories SET status = 'closed', closed_at = ? WHERE status = 'open' AND last_ts < ?")
    .run(now, now - coldMs).changes;
}
function allStories() { ensureSchema(); return newsdb.get().prepare('SELECT * FROM news_stories ORDER BY id').all().map(hydrateStory); }

// --- Stage 2: cluster a batch of items into the rolling registry ------------
// items: news_items rows ({id, source, title, summary, ts}). deps.adjudicate(A,B)→bool for the middle
// band (optional; absent → the ambiguous item opens a NEW story, the conservative default). Returns
// {attached, created, touchedStoryIds}. Stories persist across calls (hours).
async function clusterItems(items, { now = Date.now(), adjudicate = null, bands = {}, maxAgeMs = 6 * 3600 * 1000, log } = {}) {
  ensureSchema();
  let attached = 0, created = 0; const touched = new Set();
  const open = openStories({ now, maxAgeMs });   // in-memory working set; mutated as we attach
  for (const item of (items || [])) {
    const sig = signatureOf(item);
    let best = null, bestS = 0;
    for (const st of open) {
      const s = continuationScore({ entities: st.entity_set, title: tokenSet(st.title, 4) }, sig);
      if (s > bestS) { bestS = s; best = st; }
    }
    const verdict = best ? classifyContinuation(bestS, bands) : 'new';
    let decision = verdict;
    if (verdict === 'ambiguous') {
      let same = false;
      if (typeof adjudicate === 'function') { try { same = !!(await adjudicate(best, item)); } catch { same = false; } }
      decision = same ? 'continue' : 'new';
    }
    if (decision === 'continue' && best) { attachItem(best, item, sig, now); attached++; touched.add(best.id); }
    else { const id = createStory(item, sig, now); created++; touched.add(id); open.push(hydrateStory(newsdb.get().prepare('SELECT * FROM news_stories WHERE id = ?').get(id))); }
  }
  if (log) log(`[news-lane] cluster: +${created} stories, ${attached} continuations over ${(items || []).length} items`);
  return { attached, created, touchedStoryIds: [...touched] };
}

// --- cluster adjudicator (the ambiguous-band tiebreaker) --------------------
// clusterItems calls this for the MIDDLE band (0.30–0.60), where the deterministic gate can't decide —
// which is where real cross-source variants of the same event live (measured: BBC-vs-NBC Kyiv S=0.42).
// Given an OPEN story + a candidate item, ask the cloud: same underlying event? Cheap grounded yes/no.
// Fail-safe → FALSE (don't merge) on any error/uncertainty. `ask` = cloud_logic.ask (injected; offline
// tests pass a mock). Live wiring: adjudicate: (s, i) => adjudicateSameEvent(s, i, { ask: cloudAsk }).
const ADJ_SYSTEM = 'You decide whether a news item reports the SAME underlying event as an existing story. Same event = the same incident or development — same who + what + where + when — even if the wording, figures, or angle differ. Two stories that merely share a topic, place, or person but describe DIFFERENT incidents are NOT the same. Output ONLY a JSON object: {"same": true} or {"same": false}.';
function adjInput(story, item) {
  return {
    story: { title: (story && story.title) || '', entities: [...((story && story.entity_set) || [])].slice(0, 12) },
    item: { title: (item && item.title) || '', summary: String((item && item.summary) || '').slice(0, 240) },
  };
}
function adjValidate(raw) {
  const m = String(raw == null ? '' : raw).match(/\{[\s\S]*\}/);
  if (!m) return { valid: false, error: 'no json' };
  try { const o = JSON.parse(m[0]); return typeof o.same === 'boolean' ? { valid: true, value: o } : { valid: false, error: 'no boolean same' }; }
  catch (e) { return { valid: false, error: e.message }; }
}
async function adjudicateSameEvent(story, item, { ask } = {}) {
  if (typeof ask !== 'function') return false;
  try {
    // cloud_logic.ask has no `system` param — the rules go in `want`.
    const r = await ask({ task: 'news_cluster_adjudicate', v: 1, input: adjInput(story, item), want: `${ADJ_SYSTEM}\n\nOutput ONLY {"same": true} or {"same": false}.`, validate: adjValidate });
    return !!(r && r.same === true);
  } catch { return false; }
}

// --- hourly layer + deterministic briefing ----------------------------------
// A plain, model-free briefing over the stories touched this hour, ranked by corroboration then recency.
function buildBriefing(stories, { top = 8 } = {}) {
  const rc = (s) => Number(s.report_count) || (s.report_set instanceof Set ? s.report_set.size : 0);
  const oc = (s) => Number(s.outlet_count) || 0;
  const corr = (s) => Math.min(oc(s), rc(s));                          // independent corroboration = min(outlets, reports)
  // rank by INDEPENDENT corroboration, then reach, then recency — a widely-syndicated OR single-outlet
  // spread story does NOT outrank a genuinely multi-outlet, multi-report one.
  const ranked = (stories || []).slice().sort((a, b) => (corr(b) - corr(a)) || (oc(b) - oc(a)) || (b.source_count - a.source_count) || (b.last_ts - a.last_ts));
  const lines = ranked.slice(0, top).map((s) => {
    let badge = '';
    if (corr(s) > 1) badge += ` (${corr(s)} reports)`;                // independent corroboration (NOT syndicated / single-outlet inflation)
    if (oc(s) > corr(s) && oc(s) > 1) badge += ` (${oc(s)} outlets)`; // reach, shown separately from corroboration
    if (s.update_count > 1) badge += ' (developing)';                 // multi-touch = a developing story
    if (s.redaction) badge += ' ⚠correction';                        // integrity flag
    return `• ${s.title}${badge}`;
  });
  return lines.join('\n');
}
function createLayer({ hourStart, hourEnd, briefing, itemCount, storyCount, now = Date.now() }) {
  ensureSchema();
  const info = newsdb.get().prepare(
    'INSERT INTO news_layers (hour_start, hour_end, briefing, item_count, story_count, organized_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(hourStart, hourEnd, briefing || '', itemCount || 0, storyCount || 0, now);
  return info.lastInsertRowid;
}
function recentLayers(limit = 24) { ensureSchema(); return newsdb.get().prepare('SELECT * FROM news_layers ORDER BY hour_start DESC LIMIT ?').all(limit); }

// Stories updated within the window (last_ts >= startMs), most-corroborated first — the read side of
// the snapshot + the hourly briefing.
function storiesActiveInWindow(startMs, { limit = 200 } = {}) {
  ensureSchema();
  // rank by INDEPENDENT corroboration first = min(outlets, reports) (defeats syndication + single-outlet
  // inflation), then reach, then recency
  return newsdb.get().prepare('SELECT * FROM news_stories WHERE last_ts >= ? ORDER BY MIN(outlet_count, report_count) DESC, outlet_count DESC, source_count DESC, last_ts DESC LIMIT ?').all(startMs, limit).map(hydrateStory);
}

// Local start-of-day in ms (the snapshot's default "today" window).
function startOfDayMs(now = Date.now()) { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); }

// THE ONE COMPRESSION PATH — used BOTH by the hourly cadence (writeLayer:true) and the on-demand
// snapshot (writeLayer:false). Reads UN-CLUSTERED reservoir items in the window, clusters them into the
// rolling stories, closes stale stories, and returns a briefing over the stories active in the window.
// Idempotent via the story_id-IS-NULL guard in the store, so on-demand + scheduled runs never collide.
async function runCompression({ store, startMs, endMs = Date.now(), now = Date.now(), adjudicate = null, classifyAds = null, classifyEmailAds = null, writeLayer = false, coldMs = 6 * 3600 * 1000, log } = {}) {
  ensureSchema();
  let items = (store && typeof store.unclusteredInWindow === 'function') ? store.unclusteredInWindow(startMs, endMs) : [];
  // Stage-1 AD FILTER: drop ADVERTISEMENT items before clustering so they never become "stories". Two
  // independent classifiers, each scoped to its own source_kind (RSS/aggregator text is editorial, never
  // touched): 'video' → broadcast-ad classifier; 'newsletter' → email-promo classifier (the tier-2 soft
  // cases the intake heuristic passed). Both do the soft calls the free heuristics can't. Fail-safe:
  // classifier error → keep everything.
  let droppedAds = 0;
  const adStages = [
    { kinds: ['video'], fn: classifyAds },
    { kinds: ['newsletter'], fn: classifyEmailAds },
  ];
  for (const stage of adStages) {
    if (typeof stage.fn !== 'function') continue;
    const subset = items.filter((i) => stage.kinds.includes(i.source_kind));
    if (!subset.length) continue;
    let verdict = {}; try { verdict = (await stage.fn(subset)) || {}; } catch { verdict = {}; }
    const adIds = subset.filter((v) => verdict[v.id] === 'ad').map((v) => v.id);
    if (adIds.length) {
      try { store.markDropped && store.markDropped(adIds); } catch {}
      const adSet = new Set(adIds); items = items.filter((i) => !adSet.has(i.id)); droppedAds += adIds.length;
    }
  }
  const cluster = await clusterItems(items, { now, adjudicate, log });
  const closed = closeStaleStories({ now, coldMs });
  const stories = storiesActiveInWindow(startMs);
  const briefing = buildBriefing(stories);
  let layerId = null;
  if (writeLayer) layerId = createLayer({ hourStart: startMs, hourEnd: endMs, briefing, itemCount: items.length, storyCount: cluster.touchedStoryIds.length, now });
  if (log) log(`[news-compress] ${items.length} items → +${cluster.created}/${cluster.attached} stories, ${closed} closed${droppedAds ? `, ${droppedAds} ads dropped` : ''}${writeLayer ? `, layer ${layerId}` : ''}`);
  return { items: items.length, created: cluster.created, attached: cluster.attached, closed, droppedAds, briefing, storyCount: stories.length, layerId };
}

// SNAPSHOT ("dam") — triggers the compression on the un-clustered tail so "right now" is FRESH, then
// returns the briefing over the window. Default window = today→now; pass sinceMs for "update since <t>".
// No separate summarizer — the snapshot IS a compression run + its briefing (writeLayer:false).
async function snapshot({ store, sinceMs = null, now = Date.now(), adjudicate = null, classifyAds = null, classifyEmailAds = null, log } = {}) {
  const startMs = sinceMs != null ? sinceMs : startOfDayMs(now);
  const c = await runCompression({ store, startMs, endMs: now, now, adjudicate, classifyAds, classifyEmailAds, writeLayer: false, log });
  return { since: startMs, now, briefing: c.briefing, storyCount: c.storyCount, freshItems: c.items };
}

// --- daily pass: worthy rolling stories → Echo `event` objects + edges ------
// Mirrors promoteDocumentsPass: pure recipe here, Echo `dispatch` + `landDoc` INJECTED. Runs
// NON-autonomous (ingest_file/extract are write-tier) — main.js calls it on the nightly cadence.

function setEventRef(storyId, ref) {
  ensureSchema();
  newsdb.get().prepare('UPDATE news_stories SET event_ref = ? WHERE id = ?').run(String(ref), storyId);
}

// Markdown evidence doc for a story → doc_store.land → the promote rail ingests it + extract_entities.
function buildStoryDoc(story) {
  const sources = [...(story.source_set || [])];
  return `# ${story.title}\n\n**Sources:** ${sources.join(', ') || 'n/a'}  \n**First seen:** ${new Date(story.first_ts).toISOString()}  \n**Last update:** ${new Date(story.last_ts).toISOString()}\n\n${story.summary || ''}`.trim();
}

// Worthy stories to promote: open OR closed within the grace window, source-corroborated enough. Newest+
// most-corroborated first. (Idempotent on event_ref, so re-promoting an open story just updates it.)
function storiesForDaily({ now = Date.now(), closedGraceMs = 36 * 3600 * 1000, minSourceCount = 1, limit = 100 } = {}) {
  ensureSchema();
  return newsdb.get().prepare(
    `SELECT * FROM news_stories
     WHERE source_count >= ? AND (status = 'open' OR (status = 'closed' AND closed_at >= ?))
     ORDER BY source_count DESC, last_ts DESC LIMIT ?`
  ).all(minSourceCount, now - closedGraceMs, limit).map(hydrateStory);
}

// Propose the story as an Echo `event` entity and CAPTURE its entity_id (the graph_walk helper discards
// it — we need it for event_ref idempotency). propose_entity → {action, entity_id, name}. Fail-soft.
async function proposeEventObject({ dispatch, name, summary }) {
  if (typeof dispatch !== 'function' || !name) return { ok: false };
  try {
    const args = { name: String(name).slice(0, 200), entity_type: 'event' };
    if (summary) args.summary = String(summary).slice(0, 1200);
    const r = await dispatch({ kind: 'do', name: 'propose_entity', args });
    if (!r || !r.ok) return { ok: false };
    let entityId = null, action = null;
    try { const p = JSON.parse(r.text); entityId = p.entity_id != null ? p.entity_id : (p.result && p.result.entity_id); action = p.action; } catch {}
    return { ok: true, entityId, action };
  } catch { return { ok: false }; }
}

// Promote ONE story: land evidence doc (→ promote rail extracts entities later), propose the event hub
// (idempotent on event_ref), then forge event→principal edges. Edges use propose_relation ONLY (both
// endpoints must already exist) — we do NOT guess principal types (extract_entities_from_doc creates
// them with correct types on the nightly ingest); an edge to a not-yet-existing principal fails soft and
// forms on a later pass (eventually consistent, never a mistyped dup). Returns a per-story result.
async function promoteStory(story, { dispatch, landDoc, now = Date.now(), maxEdges = 5, log } = {}) {
  ensureSchema();
  const res = { storyId: story.id, doc: false, event: false, updated: false, edges: 0 };
  if (typeof landDoc === 'function') {
    try { await landDoc({ title: `News — ${story.title}`.slice(0, 120), body: buildStoryDoc(story), source: 'news', ref: `news:story:${story.id}`, understanding: story.summary || '' }); res.doc = true; }
    catch (e) { log && log('[news-daily] doc land failed: ' + (e && e.message)); }
  }
  if (!story.event_ref) {
    const ev = await proposeEventObject({ dispatch, name: story.title, summary: story.summary });
    if (ev.ok && ev.entityId != null) { setEventRef(story.id, ev.entityId); story.event_ref = String(ev.entityId); res.event = true; }
  } else { res.updated = true; }
  const principals = extractProperNouns(`${story.title}. ${story.summary || ''}`).slice(0, maxEdges);
  for (const p of principals) {
    try {
      const rr = await dispatch({ kind: 'do', name: 'propose_relation', args: { source_name: String(story.title).slice(0, 200), target_name: String(p).slice(0, 200), relation_type: 'involves' } });
      if (rr && rr.ok) res.edges++;
    } catch { /* endpoint not present yet — forms on a later pass */ }
  }
  return res;
}

// The nightly news-organization pass. Returns { promoted, updated, docs, edges, stories }.
async function runDailyPass({ dispatch, landDoc, now = Date.now(), limit = 100, log } = {}) {
  ensureSchema();
  const stories = storiesForDaily({ now, limit });
  let promoted = 0, updated = 0, docs = 0, edges = 0;
  for (const s of stories) {
    const r = await promoteStory(s, { dispatch, landDoc, now, log });
    if (r.event) promoted++; if (r.updated) updated++; if (r.doc) docs++; edges += r.edges;
  }
  if (log) log(`[news-daily] pass: ${promoted} new event objects, ${updated} updated, ${docs} docs, ${edges} edges over ${stories.length} stories`);
  return { promoted, updated, docs, edges, stories: stories.length };
}

module.exports = {
  // pure
  tokenSet, entitySet, jaccard, continuationScore, classifyContinuation, signatureOf,
  parseAggregatorMembers, dedupeGrowingCaptions, isAdLine, stripAdLines, collapseRepeatedTitles,
  // confirmation: corroboration + redaction
  outletsOf, reportIdent, reportKeysOf, isSyndicatedRepublication, detectRedactionSignal, corroborationTier, newOutletsSince, storyConfirmation,
  // stories/layers store
  ensureSchema, openStories, createStory, attachItem, closeStaleStories, allStories,
  buildBriefing, createLayer, recentLayers, storiesActiveInWindow, startOfDayMs,
  // developing-story deltas
  recordUpdate, storyDeltas, formatDeltas,
  // orchestration
  clusterItems, runCompression, snapshot,
  // cluster adjudicator (ambiguous-band tiebreaker)
  adjInput, adjValidate, adjudicateSameEvent,
  // daily pass (stories → Echo event objects)
  setEventRef, buildStoryDoc, storiesForDaily, proposeEventObject, promoteStory, runDailyPass,
};
