/* smoke_id_scheme_type.js — what an identifier scheme proves about kind (design §2a-ii step 1).
 *
 * The load-bearing test is the LDA REFUSAL. An lda_client id looks like it means "organisation", and
 * typing on it is exactly the bug that started this whole thread: Fulton County is a county GOVERNMENT
 * that appears in a lobbying register as a client, and the ROLE became the TYPE.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_id_scheme_type.js
 */
'use strict';
const st = require('../lib/id_scheme_type');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

// ── schemes whose REGISTER is defined by kind ────────────────────────────────────────────────────
ok(st.typeFromIds('Richard Nixon [N000116]').type === 'person',
  'a bioguide code is a PERSON by construction — the Biographical Directory contains nothing else');
ok(/bioguide/.test(st.typeFromIds('Richard Nixon [N000116]').why), 'and it says which scheme proved it');
ok(st.typeFromIds('Someone [ocd-person/abc-123]').type === 'person', 'an ocd-person id is a person');

// FEC ids are self-describing by prefix.
ok(st.fecType('H4CA22120') === 'person' && st.fecType('S001163') === 'person' && st.fecType('P80001571') === 'person',
  'FEC H/S/P = a CANDIDATE, which is a person');
ok(st.fecType('C0001234') === 'organization', 'FEC C = a committee, which is an organisation');
ok(st.typeFromIds('Some Cmte [FEC:C0001234]').type === 'organization', 'and that flows through the parser');

// ── THE LDA REFUSAL — the original bug, in one test ──────────────────────────────────────────────
{
  const r = st.typeFromIds('FULTON COUNTY [lda_client:206504]');
  ok(r === null,
    'CRITICAL: an lda_client id proves NOTHING about kind — Fulton County is a GOVERNMENT that hired a lobbyist');
}
ok(st.SCHEME_TYPE.lda === null, 'the refusal is explicit in the table, not an accident of parsing');

// ── a QID says nothing on its own ────────────────────────────────────────────────────────────────
ok(st.typeFromIds('Duke Energy [Q1264404]') === null && st.typeFromIds('Woodrow Wilson [wd:Q34296]') === null,
  'CRITICAL: a bare QID cannot tell a utility from a president — that needs the P31 lookup, not a guess');

// ── disagreement is refused, never picked ────────────────────────────────────────────────────────
{
  const r = st.typeFromIds('Confused Row [N000116] [FEC:C0001234]');
  ok(r && r.type === null && /disagree/.test(r.why),
    'CRITICAL: two schemes disagreeing means a wrong id or a fused row — worse than an unresolved type');
}

// ── nothing to say ───────────────────────────────────────────────────────────────────────────────
ok(st.typeFromIds('Plain Old Name') === null, 'a name with no identifier proves nothing');
ok(st.typeFromIds('') === null && st.typeFromIds(null) === null && st.typeFromIds() === null,
  'garbage in → null, never throws');

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
