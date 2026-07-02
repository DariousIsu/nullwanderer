/**
 * lib/news_ads.js — broadcast AD FILTER for the video-caption lane (SNR fix).
 *
 * The 24/7 YouTube-live news streams run frequent ad breaks; caption capture grabs the ads too, and an ad
 * with proper nouns (a Musk/Nvidia promo) can pollute a real story. Filtering ads from caption text alone
 * is hard, so this is TWO-TIER + cost-aware:
 *   1. adHeuristic(text) — PURE, free. Catches the OBVIOUS: pharma ("ask your doctor"), CTA/price ("40% off",
 *      "call 1-800"), infomercial patterns. Returns 'ad' | 'news' | 'unsure'. Runs at CAPTURE (drops hard ads
 *      before they ever hit the bucket) — no model, no latency.
 *   2. classifyBatch(segments,{ask}) — the SOFT ads (testimonials, native promos) need judgment. Only the
 *      'unsure' remainder goes to the model, in ONE batched call, at the HOURLY compression (not per-segment
 *      — that would be thousands of calls/day). Fail-safe: model down / unsure → treated as NEWS (never drop
 *      what we can't confidently call an ad).
 *
 * Only ever classifies source_kind='video' items — RSS/aggregator text is editorial, never touched.
 */
'use strict';

const str = (s) => String(s == null ? '' : s);

// Hard, unambiguous advertising markers (a news report doesn't say these).
const AD_STRONG = [
  /\b\d{1,3}\s*%\s*off\b/i,
  /\bfor (just|only) \$\d/i,
  /\$\d+(\.\d+)?\s*(a month|\/mo|per month|per year)\b/i,
  /\bcall (now |today )?1[-\s]?800\b/i,
  /\b(visit|go to|log ?on to|order (at|online at)|shop at)\b[^.]{0,28}\.(com|net|org|gov)\b/i,
  /\bside effects\b/i, /\bask your doctor\b/i, /\btalk to your doctor\b/i, /\bprescription\b/i,
  /\bclinically proven\b/i, /\bfda[-\s]approved\b/i,
  /\bmoney[-\s]back guarantee\b/i, /\brisk[-\s]free\b/i,
  /\border (now|today)\b/i, /\bin stores (now|everywhere)\b/i, /\bavailable (now |today )?(at|in stores|online)\b/i,
  /\bpromo code\b/i, /\blimited[-\s]time offer\b/i, /\bcoupon\b/i, /\bfinancing available\b/i,
];
// Clear NEWS attribution/register (an ad doesn't say these).
const NEWS_STRONG = [
  /\b(officials?|authorities|police|prosecutors?|investigators?|witnesses?)\b/i,
  /\baccording to\b/i, /\breported (that|by)\b/i, /\bin a statement\b/i, /\bspokes(person|man|woman)\b/i,
  /\b(president|senator|governor|lawmakers?|congress|parliament|the ministry|white house|pentagon|state department|supreme court|court ruled)\b/i,
  /\b(killed|wounded|arrested|indicted|evacuated|casualties|death toll|ceasefire|airstrike|election results?)\b/i,
];

// 'ad' | 'news' | 'unsure' — deliberately conservative (only decisive on a clear marker with no counter-marker).
function adHeuristic(text) {
  const t = str(text);
  if (t.trim().length < 12) return 'unsure';
  const ad = AD_STRONG.some((r) => r.test(t));
  const news = NEWS_STRONG.some((r) => r.test(t));
  if (ad && !news) return 'ad';
  if (news && !ad) return 'news';
  return 'unsure';
}

// --- batched model classification (the SOFT ads) ---------------------------
function classifyInput(segments) {
  return (segments || []).map((s) => ({ id: s.id, text: str(s.summary || s.title).replace(/\s+/g, ' ').slice(0, 300) }));
}
const CLASSIFY_WANT = `You are labeling short BROADCAST TRANSCRIPT snippets as NEWS or ADVERTISEMENT.
ADVERTISEMENT = a commercial: product/service promo, testimonial, drug/pharma ad, infomercial, sponsorship read, "brought to you by".
NEWS = actual reporting: events, politics, markets analysis, interviews about news.
For EACH input id, output your call. Respond with ONLY a JSON array, one entry per id, nothing else:
[{"id": <id>, "ad": true|false}]`;
// Extract EACH {"id":N,"ad":bool} verdict by regex rather than parsing the whole array. Robust to the
// model's ```json code fences, surrounding prose, AND truncation (a cut-off tail just yields fewer
// verdicts — those segments default to news). This is why the first live run kept ads: gemma returned
// the right calls but fenced+truncated, so a strict whole-array parse rejected all of them.
function classifyValidator(raw) {
  const s = str(raw);
  const out = [];
  const re = /\{\s*"id"\s*:\s*"?(\d+)"?\s*,\s*"ad"\s*:\s*(true|false)\s*\}/gi;
  let m;
  while ((m = re.exec(s)) !== null) out.push({ id: Number(m[1]), ad: m[2].toLowerCase() === 'true' });
  return out.length ? { valid: true, value: out } : { valid: false, error: 'no {id, ad} verdicts found' };
}

// Classify a set of video segments → { [id]: 'ad' | 'news' }. Heuristic first (free); only the 'unsure'
// remainder hits the model, in one call. deps.ask = cloud_logic.ask. Fail-safe: unclassifiable → 'news'.
async function classifyBatch(segments, { ask = null, model = null, numPredict = 1600 } = {}) {
  const verdict = {};
  const unsure = [];
  for (const s of (segments || [])) {
    const h = adHeuristic(s.summary || s.title);
    if (h === 'ad' || h === 'news') verdict[s.id] = h; else unsure.push(s);
  }
  if (unsure.length && typeof ask === 'function') {
    try {
      const r = await ask({ task: 'news_ad_classify', v: 1, input: classifyInput(unsure), want: CLASSIFY_WANT, validate: classifyValidator, model, numPredict });
      if (Array.isArray(r)) for (const e of r) if (e && e.id != null) verdict[e.id] = e.ad ? 'ad' : 'news';
    } catch { /* fail-safe below */ }
  }
  for (const s of (segments || [])) if (!verdict[s.id]) verdict[s.id] = 'news';   // never drop the unclassifiable
  return verdict;
}

module.exports = {
  AD_STRONG, NEWS_STRONG, adHeuristic,
  classifyInput, classifyValidator, CLASSIFY_WANT, classifyBatch,
};
