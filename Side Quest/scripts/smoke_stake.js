/* Smoke: lib/stake — WHOSE INTEREST does a source serve (methodology parity, S1).
 *
 * The axis her provenance was missing. authority_tier says how OFFICIAL a source is; stake says
 * whether the source BENEFITS from the claim. The dangerous error is asymmetric — calling a
 * company's own number `independent` launders it into print — so these assertions push hardest on
 * the conservative direction: unknown unless there is positive evidence.
 *
 * Pure: no model/file/db/network. Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_stake.js
 */
'use strict';
const st = require('../lib/stake');
const { STAKE } = st;

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const S = (o) => st.classifyStake(o).stake;

// --- nameTokens: the distinctive half of a name -------------------------------------------------
ok(st.nameTokens('Meta Platforms, Inc.').includes('meta'), 'nameTokens keeps the distinctive brand');
ok(!st.nameTokens('Meta Platforms, Inc.').includes('inc'), 'nameTokens drops corporate suffixes');
ok(st.nameTokens('National Rural Electric Cooperative Association').join(' ') === 'rural cooperative',
  'nameTokens drops org vocabulary AND domain words (national/electric/association) — they identify nobody');

// --- hostBelongsTo: only a distinctive LABEL match counts ---------------------------------------
ok(st.hostBelongsTo('about.meta.com', 'Meta Platforms, Inc.'), 'a subdomain of the subject belongs to it');
ok(st.hostBelongsTo('raineycenter.org', 'Rainey Center'), 'a concatenated brand label belongs to it');
ok(!st.hostBelongsTo('nytimes.com', 'Meta Platforms, Inc.'), 'an unrelated outlet does not belong to the subject');
ok(!st.hostBelongsTo('energy.example.com', 'Conservative Energy Network'),
  '⭐ a GENERIC word shared with the host does not make it the subject\'s site');
ok(!st.hostBelongsTo('centerforX.org', 'Center'), 'a name with no distinctive token matches nothing');

// --- classifyStake: the four outcomes -----------------------------------------------------------
ok(S({ url: 'https://about.meta.com/news/2024/grants', subject: 'Meta Platforms' }) === STAKE.SUBJECT_REPORTED,
  '⭐ the subject\'s own site reporting its own grant total is SUBJECT_REPORTED');
ok(S({ url: 'https://www.prnewswire.com/news-releases/meta-announces', subject: 'Meta Platforms' }) === STAKE.SUBJECT_REPORTED,
  '⭐ a press-release wire is the subject speaking, whatever host it sits on');
ok(S({ url: 'https://www.eia.gov/electricity/data.php', subject: 'Meta Platforms' }) === STAKE.INDEPENDENT,
  'a government record about someone else is INDEPENDENT');
ok(S({ url: 'https://www.entergy.com/storm-charges', subject: 'Entergy', accepted: true }) === STAKE.INTERESTED_ACCEPTED,
  '⭐ an interested party\'s figure accepted by a regulator is INTERESTED_ACCEPTED, not confirmed');
ok(S({ url: 'https://www.nytimes.com/2024/grid.html', subject: 'Meta Platforms' }) === STAKE.UNKNOWN,
  '⭐ a major outlet is probably independent — "probably" is what launders numbers, so UNKNOWN');
ok(S({}) === STAKE.UNKNOWN, 'no source location → UNKNOWN');
ok(S({ url: 'https://example.com/x' }) === STAKE.UNKNOWN, 'no subject to compare against → UNKNOWN');

// ⭐ OFFICIALNESS DOES NOT CANCEL INTEREST — checked before the .gov rule on purpose.
ok(S({ url: 'https://www.cityofmiami.gov/about', subject: 'City of Miami' }) === STAKE.SUBJECT_REPORTED,
  '⭐ a .gov page published by the body the claim is ABOUT is subject-reported, not independent');

// --- label: the five print labels are DERIVED, never stored -------------------------------------
ok(st.label({ authority_tier: 1, stake: STAKE.INDEPENDENT }).label === 'CONFIRMED', 'independent + official → CONFIRMED');
ok(st.label({ authority_tier: 2, stake: STAKE.INDEPENDENT }).label === 'CONFIRMED', 'independent + major outlet → CONFIRMED');
ok(st.label({ authority_tier: 1, stake: STAKE.SUBJECT_REPORTED }).label === 'COMPANY-REPORTED',
  '⭐ HIGH authority does NOT rescue an interested source — a company press release is still company-reported');
ok(st.label({ authority_tier: 1, stake: STAKE.INTERESTED_ACCEPTED }).label === 'ATTRIBUTE-TO-UTILITY', 'interested + accepted → ATTRIBUTE-TO-UTILITY');
ok(st.label({ authority_tier: 0, stake: STAKE.UNKNOWN }).label === 'NOT VERIFIED', 'unknown → NOT VERIFIED (do not publish)');
ok(st.label({ authority_tier: 3, stake: STAKE.INDEPENDENT }).label === 'NOT VERIFIED', 'merely TOLD is not confirmation, even from a disinterested party');
ok(st.label({ authority_tier: 2, stake: STAKE.INDEPENDENT, cutsAgainst: true }).label === 'COUNTER-EVIDENCE',
  '⭐ counter-evidence outranks the source axes — it is a stance, carried whoever reported it');
ok(/never omit/i.test(st.label({ cutsAgainst: true }).print), 'counter-evidence prints as never-omit');
ok(st.label({ authority_tier: 1, stake: STAKE.SUBJECT_REPORTED }).attribute === true, 'an interested claim must be attributed in print');
ok(st.label({ authority_tier: 1, stake: STAKE.INDEPENDENT }).attribute === false, 'a confirmed claim needs no attribution caveat');
ok(st.label({ stake: 'nonsense' }).label === 'NOT VERIFIED', 'an unrecognised stake degrades to NOT VERIFIED, never to CONFIRMED');

// --- stampCitation: additive, and never overwrites --------------------------------------------
{
  const c = st.stampCitation({ url: 'https://about.meta.com/news', authority_tier: 1 }, { subject: 'Meta Platforms' });
  ok(c.stake === STAKE.SUBJECT_REPORTED && c.authority_tier === 1 && c.url, 'stamp adds stake and keeps every existing field');
  ok(typeof c.stake_why === 'string' && c.stake_why.length > 0, 'stamp records WHY, so a wrong label can be argued with');
  const pre = st.stampCitation({ url: 'https://about.meta.com/news', stake: STAKE.INDEPENDENT }, { subject: 'Meta Platforms' });
  ok(pre.stake === STAKE.INDEPENDENT, 'an already-established stake is never overwritten');
  ok(st.stampCitation(null, {}).stake === STAKE.UNKNOWN, 'stamping a null citation degrades to unknown, never throws');
}

// --- the label TRAVELS: it must reach the synthesis prompt, not just exist ---------------------
// A stake nobody sees is decoration. The methodology's rule is that the label rides the claim all the
// way to the page, so the annotation belongs in the SOURCES list the model is told to cite from.
{
  const rs = require('../lib/research');
  const p = rs.buildUnderstandTargetPrompt({
    goal: 'community benefits', target: 'Meta Platforms', raw: 'notes',
    sources: ['https://about.meta.com/news/2024/grants', 'https://www.eia.gov/electricity/data.php', 'https://www.nytimes.com/2024/grid.html'],
  });
  const sys = p[0].content, usr = p[1].content;
  ok(/belongs to Meta Platforms: attribute any figure/.test(usr), '⭐ the subject\'s own page is flagged INSIDE the sources the model must cite from');
  ok(/eia\.gov[^\n]*independent record/.test(usr), 'a government record is marked independent');
  ok(!/nytimes\.com[^\n]*<-/.test(usr), '⭐ an UNKNOWN source carries no annotation — a label with nothing behind it is noise');
  ok(/WHOSE NUMBER IS IT/.test(sys), 'the system prompt carries the rule that makes the annotation binding');
  ok(/never as independent fact/.test(usr), 'the annotation says what to DO, not merely what it is');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
