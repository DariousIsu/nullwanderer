/*
 * lib/video_reconstruct.js — BROADCAST SEGMENT RECONSTRUCTION (design: the CC→brief enrichment).
 *
 * Live-broadcast closed captions arrive fragmentary (partial words, ALL-CAPS chyrons, mid-sentence), so a
 * raw video item's title is garbage — it produces no usable entities, never clusters with the RSS wire
 * story, and sits as a single-source island the briefing never surfaces. This lane fixes that:
 *
 *   1. GROUP a stream's time-adjacent caption flushes into a SEGMENT (one broadcast topic block).
 *   2. RECONSTRUCT (one conservative cloud pass per segment): the fragmentary captions → a clean {headline,
 *      summary, is_news}. "Fill in the blank" = reconstruct what the anchor CLEARLY reports — never invent.
 *   3. WRITE the clean headline/summary onto the segment's representative item + ABSORB the rest, so exactly
 *      ONE clean report per segment enters clustering. Non-news / ad segments are dropped.
 *
 * The reconstructed segment then clusters like any item: outletsOf() → the stream (CNN/ABC) is a distinct
 * OUTLET, reportKeysOf() → its headline is a distinct REPORT. Merging into the matching RSS story (adjudicator-
 * gated in news_lane) makes the broadcast genuine cross-modal corroboration. Over time, later flushes of a
 * continuing segment reconstruct + attach as the story DEVELOPS (min(outlet,report) caps single-outlet inflation).
 *
 * SAFETY: a reconstruction that doesn't align with a real wire story stays a single-source island (low rank,
 * never in the brief top) — so the corroboration gate is itself the hallucination filter. Pure helpers are
 * unit-tested; the cloud + DB ops take injected deps (offline-testable).
 */
'use strict';

const clean = (s) => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();

// Group video items into segments: same stream (source), consecutive in time within gapMs. A larger gap or a
// stream change starts a new segment. Returns [{ stream, sourceUrl, firstTs, lastTs, itemIds, repId, captions }].
// repId = the representative item (latest, most-settled) whose text we overwrite with the reconstruction.
function groupIntoSegments(videoItems, { gapMs = 120000 } = {}) {
  const items = (videoItems || []).filter((i) => i && (i.source_kind === 'video')).slice()
    .sort((a, b) => (clean(a.source).toLowerCase()).localeCompare(clean(b.source).toLowerCase()) || (a.ts || 0) - (b.ts || 0) || (a.id || 0) - (b.id || 0));
  const segs = [];
  let cur = null;
  for (const it of items) {
    const stream = clean(it.source);
    const ts = Number(it.ts) || 0;
    if (cur && cur.stream === stream && ts - cur.lastTs <= gapMs) {
      cur.itemIds.push(it.id); cur.captions.push(clean(it.summary) || clean(it.title)); cur.lastTs = ts; cur.repId = it.id;
    } else {
      if (cur) segs.push(cur);
      cur = { stream, sourceUrl: clean(it.sourceUrl) || null, firstTs: ts, lastTs: ts, itemIds: [it.id], repId: it.id, captions: [clean(it.summary) || clean(it.title)] };
    }
  }
  if (cur) segs.push(cur);
  for (const s of segs) s.captions = s.captions.join(' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
  return segs;
}

const RECONSTRUCT_WANT = `You reconstruct a clean NEWS HEADLINE + one-sentence summary from FRAGMENTARY live TV
closed-caption text (partial words, ALL-CAPS, mid-sentence — a broadcast segment). Rules:
- Report ONLY what the captions clearly convey. DO NOT invent names, numbers, places, or facts not present.
- Fill obvious gaps (broken words, dropped articles) but never fabricate; when in doubt, stay vague.
- If the text is an advertisement, promo, station bumper, or too fragmentary to tell what the story is, set is_news=false.
- headline: a specific wire-style news headline. summary: one factual sentence.
For EACH input id respond with ONLY a JSON array, one entry per id, nothing else:
[{"id": <id>, "headline": "...", "summary": "...", "is_news": true}]`;

// Tolerant parse: strip code fences, JSON.parse; on failure recover complete objects up to the last '}'.
function reconstructValidator(raw) {
  let s = String(raw == null ? '' : raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/,'').trim();
  const coerce = (arr) => (Array.isArray(arr) ? arr : []).map((e) => {
    if (!e || e.id == null) return null;
    const isNews = e.is_news !== false;
    if (isNews && !e.headline) return null;                         // a "news" verdict with no headline is useless
    return { id: Number(e.id), headline: clean(e.headline).slice(0, 200), summary: clean(e.summary).slice(0, 400), is_news: isNews };
  }).filter(Boolean);
  try { const v = coerce(JSON.parse(s)); if (v.length) return { valid: true, value: v }; } catch {}
  const cut = s.lastIndexOf('}');                                   // truncation recovery: trim to last complete object
  if (cut > 0) { try { const v = coerce(JSON.parse(s.slice(0, cut + 1) + ']')); if (v.length) return { valid: true, value: v }; } catch {} }
  return { valid: false, error: 'no reconstructed segments parsed' };
}

// Cloud reconstruction of a batch of segments → { [repId]: { headline, summary, isNews } }. deps.ask =
// cloud_logic.ask. Fail-safe: on cloud error / unparseable / omitted id, the segment is left UNRECONSTRUCTED
// (caller keeps its raw text — never blocks, never invents).
async function reconstructBatch(segments, { ask = null, model = null, numPredict = 1400 } = {}) {
  const out = {};
  const input = (segments || []).map((s) => ({ id: s.repId, text: s.captions }));
  if (input.length && typeof ask === 'function') {
    try {
      const r = await ask({ task: 'video_reconstruct', v: 1, input, want: RECONSTRUCT_WANT, validate: reconstructValidator, model, numPredict });
      if (Array.isArray(r)) for (const e of r) if (e && e.id != null) out[e.id] = { headline: e.headline, summary: e.summary, isNews: e.is_news !== false };
    } catch { /* fail-safe: leave raw */ }
  }
  return out;
}

// Full pass: group in-window video items → reconstruct → write clean text onto each segment's representative
// and ABSORB the rest (so ONE clean report per segment clusters); drop non-news segments. Deps injected:
//   store = news_store (needs updateItemText / absorbItems / markDropped), ask = cloud_logic.ask.
// Returns { segments, reconstructed, absorbed, dropped }. Never throws.
async function runReconstruct(videoItems, { store, ask = null, model = null, gapMs = 120000, log } = {}) {
  const res = { segments: 0, reconstructed: 0, absorbed: 0, dropped: 0 };
  try {
    if (!store) return res;
    const segs = groupIntoSegments(videoItems, { gapMs });
    res.segments = segs.length;
    if (!segs.length) return res;
    const verdicts = await reconstructBatch(segs, { ask, model });
    for (const seg of segs) {
      const v = verdicts[seg.repId];
      const others = seg.itemIds.filter((id) => id !== seg.repId);
      if (v && v.isNews === false) {
        if (store.markDropped) { store.markDropped(seg.itemIds); res.dropped += seg.itemIds.length; }
        continue;
      }
      if (v && v.headline) {
        if (store.updateItemText) store.updateItemText(seg.repId, { title: v.headline, summary: v.summary || null });
        res.reconstructed++;
      }
      // absorb the non-representative flushes so only ONE clean report per segment enters clustering
      if (others.length && store.absorbItems) { store.absorbItems(others); res.absorbed += others.length; }
    }
    if (log && (res.reconstructed || res.dropped)) log(`[video-reconstruct] ${res.segments} segments → ${res.reconstructed} reconstructed, ${res.absorbed} absorbed, ${res.dropped} dropped(non-news)`);
  } catch (e) { log && log('[video-reconstruct] failed: ' + e.message); }
  return res;
}

module.exports = { groupIntoSegments, RECONSTRUCT_WANT, reconstructValidator, reconstructBatch, runReconstruct };
