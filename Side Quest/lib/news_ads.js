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

// =====================================================================
// EMAIL NEWSLETTER promo filter — the second lane's SNR fix.
//
// Zoe's inbox catches sign-up newsletters; those often carry SOME ads, and the inbox also fills with
// PURE-promo mail (LinkedIn/Yelp/Capterra notifications, retail deals, pump-and-dump stock spam). The
// governing rule (Lucas): a real newsletter that merely CONTAINS an ad is KEPT — only a wholly
// promotional/marketing/notification email is dropped. Same two-tier shape as the video filter:
//   1. emailPromoHeuristic({from,fromAddr,subject,summary}) — PURE, free. Decisive on promo senders,
//      promo subjects, stock-pump patterns → 'promo'; on long editorial bodies → 'keep'; else 'unsure'.
//      Used at INTAKE to hard-drop the obvious junk before it ever enters the bucket.
//   2. classifyEmailBatch(items,{ask}) — the 'unsure' remainder → the model, ONE batched call, at hourly
//      compression. Prompt is biased to KEEP (a newsletter-with-ads is not an ad). Fail-safe → keep.
// -----------------------------------------------------------------------------------------------------

// Registrable domains that only ever send promo/notification mail (never editorial content we'd want).
const PROMO_DOMAINS = new Set([
  'linkedin.com', 'yelp.com', 'indeed.com', 'glassdoor.com', 'ziprecruiter.com', 'monster.com',
  'capterra.com', 'getapp.com', 'softwareadvice.com', 'g2.com', 'trustradius.com',
  'groupon.com', 'meetup.com', 'nextdoor.com', 'quora.com', 'pinterest.com', 'facebookmail.com',
  'instagram.com', 'expedia.com', 'booking.com', 'grubhub.com', 'doordash.com', 'ubereats.com',
]);
function domainOf(addr) {
  const a = str(addr).toLowerCase().trim();
  const at = a.lastIndexOf('@');
  return (at >= 0 ? a.slice(at + 1) : a).replace(/[>\s].*$/, '');
}
function isPromoDomain(addr) {
  const d = domainOf(addr);
  if (!d) return false;
  for (const p of PROMO_DOMAINS) if (d === p || d.endsWith('.' + p)) return true;
  return false;
}

// Subjects that betray a purely promotional/notification email (a Substack issue doesn't say these).
const PROMO_SUBJECT = [
  /\b\d{1,3}\s*%\s*off\b/i, /\bsave \$?\d/i, /\bfree shipping\b/i, /\bflash sale\b/i, /\bsale ends\b/i,
  /\b(final|last)[-\s]chance\b/i, /\blimited[-\s]time\b/i, /\bexclusive (offer|deal|discount)\b/i,
  /\bcoupon\b/i, /\bpromo code\b/i, /\bdon'?t miss (out|this deal)\b/i, /\bcyber monday|black friday\b/i,
  /\b(add|connect with) [A-Z][a-z]+/,                       // LinkedIn "add Linda C."
  /\bviewed your (profile|post|page)\b/i, /\bpeople you may know\b/i, /\bnew connection\b/i,
  /\binvitation to connect\b/i, /\bendorsed you\b/i, /\byou (have|appeared in) \d+ (new )?(searches|notifications)\b/i,
  /\bwho'?s hiring\b/i, /\bjobs? (for you|you may|near you|matching)\b/i, /\b\d+ new jobs?\b/i, /\bis hiring\b/i,
  /\btop \w+ (revealed|of \d{4})\b/i, /\bsee who'?s #?1\b/i, /\brated #?1\b/i,
  /\bverify your (account|email)\b/i, /\bcomplete your (profile|registration)\b/i,
];
// Pump-and-dump / penny-stock spam ("(Nasdaq: USAU) fully permitted gold project"). A ticker in
// PARENTHESES in the subject/body is the tell — real market journalism writes "Nebius stock", not "(NBIS)".
const STOCK_SPAM = [
  /\((?:nasdaq|nyse|otc|otcmkts|amex|nyseamerican|cboe|tsx)\s*:\s*[A-Z.]{1,6}\)/i,
  /\bfully[-\s]permitted\b/i, /\bpenny stock\b/i, /\bmicro[-\s]?cap\b/i, /\bnano[-\s]?cap\b/i,
  /\bbuy alert\b/i, /\bhot stock\b/i, /\btable[-\s]pounding\b/i, /\bstock (to watch|pick of)\b/i,
  /\bnext (tesla|nvidia|apple|amazon|bitcoin|microsoft)\b/i, /\bskyrocket\b/i, /\bto the moon\b/i,
  /\bbefore it (explodes|takes off|runs)\b/i, /\b\d{2,4}%\s+(gain|upside|potential)\b/i,
];

// 'promo' | 'keep' | 'unsure'. Accepts the intake msg shape OR a bucket row (flexible field names).
function emailPromoHeuristic(msg) {
  if (!msg) return 'unsure';
  const addr = str(msg.fromAddr != null ? msg.fromAddr : msg.source_url);
  const subj = str(msg.subject != null ? msg.subject : msg.title);
  const body = str(msg.body != null ? msg.body : msg.summary);
  const both = subj + '\n' + body;
  if (isPromoDomain(addr)) return 'promo';
  if (STOCK_SPAM.some((r) => r.test(both))) return 'promo';
  if (PROMO_SUBJECT.some((r) => r.test(subj))) return 'promo';
  // Clearly editorial: a substantial body with multiple news-register markers → keep (skip the model).
  if (body.length > 800 && NEWS_STRONG.filter((r) => r.test(body)).length >= 2) return 'keep';
  return 'unsure';
}

const EMAIL_CLASSIFY_WANT = `You are labeling whole EMAILS as PROMO or NEWSLETTER.
PROMO = a purely promotional/marketing/transactional message: retail sale/discount/coupon, product pitch,
affiliate offer, social-network notification ("someone added you", "profile views"), job-board alert,
stock-pump/penny-stock spam, "verify your account".
NEWSLETTER = an email with editorial/journalistic/analytical CONTENT worth reading (news, commentary,
analysis, a Substack issue). A real newsletter that merely CONTAINS some ads or a sponsor blurb is still
NEWSLETTER — keep it. When unsure, choose NEWSLETTER.
For EACH input id, respond with ONLY a JSON array, one entry per id: [{"id": <id>, "ad": true|false}]
(ad:true = PROMO).`;
// For email the SUBJECT is strong signal, so fold it into the text the model sees.
function emailClassifyInput(items) {
  return (items || []).map((s) => ({ id: s.id, text: (str(s.title) + ' — ' + str(s.summary)).replace(/\s+/g, ' ').slice(0, 400) }));
}

// Classify newsletter bucket rows → { [id]: 'ad' | 'news' }. Heuristic first (free); only 'unsure' hits
// the model, in one batched call. deps.ask = cloud_logic.ask. Fail-safe: unclassifiable → 'news' (keep).
async function classifyEmailBatch(items, { ask = null, model = null, numPredict = 1600 } = {}) {
  const verdict = {};
  const unsure = [];
  for (const s of (items || [])) {
    const h = emailPromoHeuristic(s);
    if (h === 'promo') verdict[s.id] = 'ad';
    else if (h === 'keep') verdict[s.id] = 'news';
    else unsure.push(s);
  }
  if (unsure.length && typeof ask === 'function') {
    try {
      const r = await ask({ task: 'email_promo_classify', v: 1, input: emailClassifyInput(unsure), want: EMAIL_CLASSIFY_WANT, validate: classifyValidator, model, numPredict });
      if (Array.isArray(r)) for (const e of r) if (e && e.id != null) verdict[e.id] = e.ad ? 'ad' : 'news';
    } catch { /* fail-safe below */ }
  }
  for (const s of (items || [])) if (!verdict[s.id]) verdict[s.id] = 'news';   // never drop the unclassifiable
  return verdict;
}

// A KEPT newsletter (not wholly promo) may still OPEN with a sponsor block ("Together with Acme…") before
// the editorial. Strip that LEADING block so it doesn't pollute the stored summary. CONSERVATIVE by design —
// only fires when a sponsor marker sits in the first ~400 chars AND there's a clean paragraph boundary after
// it AND ≥200 chars of real content remain; otherwise returns the body UNCHANGED (never risk eating editorial).
// Relies on the email body's paragraph structure (newlines). Does NOT chase mid-body embedded ads — that
// needs full body segmentation (flagged), and a false strip there would delete real reporting.
const SPONSOR_RE = /\b(sponsored by|together with|presented by|brought to you by|a message from(?: our)? sponsor|paid partnership|this (?:issue|email|newsletter) is sponsored)\b/i;
function stripLeadingSponsor(body) {
  const t = str(body);
  const firstBreak = t.search(/\n\s*\n/);                  // end of the FIRST paragraph (needs structure)
  if (firstBreak < 0) return t;                            // no paragraph break → don't risk a cut
  if (!SPONSOR_RE.test(t.slice(0, firstBreak))) return t;  // the FIRST paragraph isn't a sponsor block → untouched
  const kept = t.slice(firstBreak).trim();                // drop the leading sponsor paragraph
  return kept.length >= 200 ? kept : t;                   // would leave too little → keep the original (safety)
}

module.exports = {
  AD_STRONG, NEWS_STRONG, adHeuristic,
  classifyInput, classifyValidator, CLASSIFY_WANT, classifyBatch,
  PROMO_DOMAINS, PROMO_SUBJECT, STOCK_SPAM, domainOf, isPromoDomain,
  emailPromoHeuristic, EMAIL_CLASSIFY_WANT, emailClassifyInput, classifyEmailBatch,
  stripLeadingSponsor,
};
