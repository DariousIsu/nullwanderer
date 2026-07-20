/* lib/news_encounters.js — a news item becomes an ENCOUNTER (W3).
 *
 * docs/ENCOUNTER_OBJECT_MODEL_DESIGN.md §2/§6. This is the first lane that can honestly reach grade A,
 * because it is the only one where the two things independence needs — a real publisher and a real
 * publication date — arrive natively rather than being reconstructed. Documents had to have their
 * origin captured at download time and their date parsed out of prose; a news item simply has both.
 *
 * ── ONE ENCOUNTER PER ITEM WE ACTUALLY FETCHED ──────────────────────────────────────────────────
 *
 * The object is the STORY (an event, keyed on its cluster key so the identity is stable across
 * headlines). Each ITEM that landed in that cluster is one outlet attesting the event happened. That is
 * the encounter. Independence then falls out of origin.independence() for free: distinct publisher
 * hosts bounded by distinct texts.
 *
 * ── AN AGGREGATOR'S OUTLET LIST IS NOT A SET OF ENCOUNTERS ──────────────────────────────────────
 *
 * Measured on live data, and it is the trap in this lane. A story reads:
 *
 *   outlet_set: ["Politico","Axios","PBS","The Washington Post","MS NOW"]   outlet_count: 5
 *   …from ONE item whose source_url is news.google.com/rss
 *
 * We never fetched Politico. We fetched Google News, which TOLD us five outlets covered it. Recording
 * that as five encounters would manufacture five independent sources from one, which is precisely the
 * inflation min(origins, texts) exists to prevent — laundered through an aggregator instead of a wire
 * service. So an item yields exactly ONE encounter, attributed to the host we actually retrieved.
 * `outlet_count` is left to the news lane's own ranking; it is not evidence here.
 *
 * ── VIDEO CAPTIONS ARE NOT NEWS ITEMS ───────────────────────────────────────────────────────────
 *
 * 58,169 of 98,563 items are YouTube caption fragments — "there is this sort of like political aspect
 * to this because, you know…". They are speech, mid-sentence, and their "title" is a transcript line,
 * not an event. Writing them as events would put 58k fragments into the object graph. Excluded here;
 * speech is its own lane.
 *
 * Pure. No db, no IO.
 */
'use strict';

const og = require('./origin');

// The kinds that are actual published reports. `video` is excluded — see the header.
const REPORTING_KINDS = new Set(['rss', 'aggregator', 'newsletter']);

// Aggregators republish other people's reporting. We still record what we fetched — unlike a CDN, an
// aggregator IS a real source that made an assertion — but it must never be mistaken for the publisher,
// and its outlet list is not corroboration.
const AGGREGATOR_HOST = /(^|\.)(news\.google\.com|news\.yahoo\.com|flipboard\.com|smartnews\.com|feedly\.com|apple\.news)$/i;

function isAggregator(hostOrUrl) {
  const h = og.hostOf(hostOrUrl) || String(hostOrUrl || '').toLowerCase().replace(/^www\./, '');
  return !!h && AGGREGATOR_HOST.test(h);
}

// Event identity is the STORY ROW, not its cluster key.
//
// The cluster key looked like the better identity — it is a normalised token set, so it survives the
// re-headlining that happens as a story develops. Measured on live data, it FALSE-MERGES:
//
//   cluster_key 'trump' spans 18 unrelated stories on different days — a market-rally quote, a pardon,
//   a speech about communism — which keyed as one object and reported independence 22. That is
//   fabricated corroboration for an event that never happened. 131 more stories have an EMPTY cluster
//   key and would all have collapsed into a single object.
//
// A wrong merge is the one unrecoverable failure; a missed merge is not. Keying on the story id means a
// genuinely re-clustered event may appear twice, and that is recoverable — the stories can be merged
// later and the encounters follow. Inventing corroboration cannot be undone once it has been believed.
function eventKey(story) {
  if (!story || story.id == null) return null;
  return `event:story:${story.id}`;
}

// One news item → one encounter, or null.
//
// The item's own timestamp is observed_at, which is the point of this lane: a publication date, stated
// by the publisher, not inferred from prose and not the moment we happened to poll.
function toEncounter(item, story) {
  if (!item || !story) return null;
  if (item.source_kind && !REPORTING_KINDS.has(String(item.source_kind))) return null;
  const key = eventKey(story);
  if (!key) return null;

  const host = og.hostOf(item.source_url);
  // Text identity from what the item actually said. Syndication — eight Advance Local papers running
  // one wire story under eight hostnames — collapses here, on the text, exactly as it should.
  const hash = og.contentHash(`${item.title || ''} ${item.summary || ''}`);

  return {
    object_type: 'event',
    object_key: key,
    object_label: story.title || item.title || null,
    claim_class: 'existence',
    claim_key: null,
    claim_value: null,
    source_kind: 'news',
    source_ref: item.id != null ? `news:${item.id}` : null,
    origin: item.source_url || null,
    origin_host: host,
    content_hash: hash,
    // News is ordinary evidence. A press outlet is not an official record, however reputable — §5's
    // authority tier is about the KIND of source, not its quality.
    authority: 'ordinary',
    // The publisher's own date. Guarded against the future for the same reason as W1: a future-dated
    // source outranks everything real under recency weighting, permanently.
    observed_at: Number.isFinite(item.ts) && item.ts <= Date.now() + 36 * 3600 * 1000 ? item.ts : null,
  };
}

module.exports = { toEncounter, eventKey, isAggregator, REPORTING_KINDS, AGGREGATOR_HOST };
