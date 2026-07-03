/* Smoke: lib/news_ads — the broadcast ad-filter (pure heuristic + batched model classify, mocked ask).
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_news_ads.js
 */
'use strict';
const ads = require('../lib/news_ads');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// ===== heuristic: obvious ads =====
ok(ads.adHeuristic('Ask your doctor if Rexulti is right for you. Side effects may include nausea.') === 'ad', 'heuristic: pharma ad → ad');
ok(ads.adHeuristic('Get 40% off your first order — visit trycasper.com today.') === 'ad', 'heuristic: CTA/discount ad → ad');
ok(ads.adHeuristic('Call now 1-800-555-0199 for a free quote.') === 'ad', 'heuristic: 800-number ad → ad');
// ===== heuristic: obvious news =====
ok(ads.adHeuristic('Officials say at least 17 people were killed in the airstrike, according to the ministry.') === 'news', 'heuristic: attribution + casualties → news');
ok(ads.adHeuristic('The president announced the decision in a statement from the White House.') === 'news', 'heuristic: political attribution → news');
// ===== heuristic: soft ads slip to unsure (need the model) =====
ok(ads.adHeuristic('I am a huge dog lover, and I buy mine when I walk my dogs to the farmers market.') === 'unsure', 'heuristic: soft testimonial ad → unsure (model decides)');
ok(ads.adHeuristic('Cottage cheese is great in moderation. It is gentle and can help.') === 'unsure', 'heuristic: native/lifestyle ad → unsure');

// ===== validator =====
ok(ads.classifyValidator('[{"id":1,"ad":true},{"id":2,"ad":false}]').valid === true, 'validator accepts a well-formed array');
const fenced = ads.classifyValidator('```json\n[{"id":1,"ad":true},{"id":2,"ad":false}]\n```');
ok(fenced.valid === true && fenced.value.length === 2, 'validator tolerates ```json code fences (the live failure mode)');
const trunc = ads.classifyValidator('[{"id":7,"ad":true},{"id":8,"ad":false},{"id":9,"ad":tr');
ok(trunc.valid === true && trunc.value.length === 2 && trunc.value[0].id === 7 && trunc.value[0].ad === true, 'validator recovers complete verdicts from a TRUNCATED array (defaults the cut-off tail to news)');
ok(ads.classifyValidator('[{"id":1}]').valid === false && ads.classifyValidator('no verdicts here').valid === false, 'validator rejects entries missing ad + non-verdict text');

// ===== classifyBatch: heuristic + model, fail-safe =====
const segs = [
  { id: 1, summary: 'Ask your doctor about this prescription. Side effects may occur.' },   // heuristic ad
  { id: 2, summary: 'Officials say the ceasefire will begin at midnight, according to authorities.' }, // heuristic news
  { id: 3, summary: 'I am a huge dog lover and I buy mine at the farmers market every week.' },  // unsure → model
  { id: 4, summary: 'Explosions rock the capital in a large-scale overnight attack.' },          // unsure → model
];
(async () => {
  // mock ask: labels the dog testimonial as ad, the attack as news
  const askMock = async ({ input }) => input.map((i) => ({ id: i.id, ad: /dog lover|farmers market/i.test(i.text) }));
  const v = await ads.classifyBatch(segs, { ask: askMock });
  ok(v[1] === 'ad' && v[2] === 'news', 'classifyBatch: heuristic resolves the obvious ones (no model needed)');
  ok(v[3] === 'ad' && v[4] === 'news', 'classifyBatch: the model resolves the soft/unsure segments');

  // only the unsure ids are sent to the model
  let sentIds = null;
  const askSpy = async ({ input }) => { sentIds = input.map((i) => i.id); return input.map((i) => ({ id: i.id, ad: false })); };
  await ads.classifyBatch(segs, { ask: askSpy });
  ok(sentIds && sentIds.length === 2 && sentIds.includes(3) && sentIds.includes(4) && !sentIds.includes(1), 'classifyBatch: ONLY the unsure segments hit the model (cost control)');

  // fail-safe: model throws → unsure default to news (never drop what we cannot confirm)
  const vSafe = await ads.classifyBatch(segs, { ask: async () => { throw new Error('cloud down'); } });
  ok(vSafe[3] === 'news' && vSafe[4] === 'news' && vSafe[1] === 'ad', 'classifyBatch: cloud down → unsure default to NEWS, heuristic ads still dropped');

  // no ask at all → only heuristic decisions, rest news
  const vNoAsk = await ads.classifyBatch(segs, {});
  ok(vNoAsk[1] === 'ad' && vNoAsk[3] === 'news', 'classifyBatch: no model → heuristic only, unsure kept as news');

  // ===== EMAIL newsletter promo filter =====
  // domain / heuristic
  ok(ads.isPromoDomain('invitations@linkedin.com') && ads.isPromoDomain('x@e.linkedin.com'), 'isPromoDomain matches linkedin.com incl. subdomain');
  ok(!ads.isPromoDomain('lucas@gmail.com') && !ads.isPromoDomain('robertreich@substack.com'), 'isPromoDomain false for real senders');
  ok(ads.emailPromoHeuristic({ fromAddr: 'noreply@linkedin.com', subject: 'Zoe, add Linda C.', body: '' }) === 'promo', 'promo sender (LinkedIn) → promo');
  ok(ads.emailPromoHeuristic({ fromAddr: 'deals@yelp.com', subject: 'Find things to do in Clearwater', body: '' }) === 'promo', 'promo sender (Yelp) → promo');
  ok(ads.emailPromoHeuristic({ fromAddr: 'paul@streetideas.co', subject: '(Nasdaq: USAU) Holds a Fully Permitted Gold Project', body: '' }) === 'promo', 'stock-pump (parens ticker + fully permitted) → promo');
  ok(ads.emailPromoHeuristic({ fromAddr: 'team@capterra.com', subject: "This year's top CRM revealed—see who's #1", body: '' }) === 'promo', 'promo subject (top X revealed / #1) → promo');
  ok(ads.emailPromoHeuristic({ fromAddr: 'shop@brand.com', subject: '40% off ends tonight — limited time', body: '' }) === 'promo', 'promo subject (discount/limited-time) → promo');
  // real editorial newsletter with a sponsor blurb → NOT dropped
  const realBody = 'Officials say the ceasefire will begin at midnight, according to authorities. '.repeat(20) + ' (This issue is brought to you by our sponsor — 20% off.)';
  ok(ads.emailPromoHeuristic({ fromAddr: 'robertreich@substack.com', subject: 'The oligarchy tightens its grip', body: realBody }) === 'keep', 'long editorial body w/ embedded sponsor line → keep (newsletter-with-ads is NOT an ad)');
  ok(ads.emailPromoHeuristic({ fromAddr: 'news@americanmarket.com', subject: 'AI Fears Hit Nebius Stock, But Has the Growth Thesis Changed', body: 'short' }) === 'unsure', 'ambiguous market-news subject (no parens ticker) → unsure (model decides, not auto-dropped)');

  // classifyEmailBatch: heuristic + model, biased-keep, cost control
  const mails = [
    { id: 1, source_url: 'noreply@linkedin.com', title: 'add Linda C.', summary: '' },                 // heuristic promo
    { id: 2, source_url: 'x@sub.com', title: 'Ceasefire holds', summary: 'Officials say, according to authorities, the president confirmed. '.repeat(20) }, // heuristic keep
    { id: 3, source_url: 'news@mkt.com', title: 'AI Fears Hit Nebius Stock', summary: 'short ambiguous' }, // unsure → model
  ];
  let emailSent = null;
  const emailAsk = async ({ input }) => { emailSent = input.map((i) => i.id); return input.map((i) => ({ id: i.id, ad: false })); };
  const ev = await ads.classifyEmailBatch(mails, { ask: emailAsk });
  ok(ev[1] === 'ad' && ev[2] === 'news', 'classifyEmailBatch: heuristic resolves obvious promo/keep');
  ok(emailSent && emailSent.length === 1 && emailSent[0] === 3, 'classifyEmailBatch: ONLY the unsure email hits the model');
  ok(ev[3] === 'news', 'classifyEmailBatch: model kept the ambiguous market-news email (biased to keep)');
  const evSafe = await ads.classifyEmailBatch(mails, { ask: async () => { throw new Error('down'); } });
  ok(evSafe[3] === 'news' && evSafe[1] === 'ad', 'classifyEmailBatch: cloud down → unsure default to keep, heuristic promo still dropped');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
