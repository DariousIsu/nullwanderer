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

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
