/**
 * Offline smoke for lib/poll_votehub.js — the VoteHub API poll adapter (Suite-A adapter #2).
 * Fixtures are REAL /polls item shapes captured live (2026-07-03). All HTTP is a mocked fetchJson —
 * zero network. Also asserts CROSS-ADAPTER shape parity with lib/poll_wikipedia (one shared shape).
 *
 * Run: node scripts/smoke_poll_votehub.js
 */
const V = require('../lib/poll_votehub');
const W = require('../lib/poll_wikipedia');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } }
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }

// --- real VoteHub /polls fixtures ---
const APPROVAL = {
  id: 'appdoninsm57hlnce', poll_type: 'approval', subject: 'Donald Trump', seat_name: null,
  pollster: 'InsiderAdvantage', sponsors: [], partisan: null, internal: false,
  population: 'rv', sample_size: 800, start_date: '2025-01-20', end_date: '2025-01-20',
  created_at: '2025-01-21', url: 'https://insideradvantage.com/x',
  answers: [{ choice: 'Disapprove', pct: 39.0 }, { choice: 'Approve', pct: 56.0 }],
};
const SENATE = {
  id: 'flsen26xyz', poll_type: 'us-senator', subject: '2026 Florida', seat_name: 'Florida Class II',
  pollster: 'Echelon Insights', sponsors: ['GBAO', 'AARP'], partisan: 'R', internal: true,
  population: 'lv', sample_size: 1000, start_date: '2026-07-10', end_date: '2026-07-12',
  url: 'https://x/y', answers: [{ choice: 'Smith', pct: 48 }, { choice: 'Jones', pct: 45 }, { choice: 'Undecided', pct: 7 }],
};
const GARBAGE = { id: 'g1', pollster: '', answers: [] };            // no pollster, no answers → dropped
const NULLY = null;

// --- normalizePoll ---
const a = V.normalizePoll(APPROVAL);
eq('approval: source_kind/tier', [a.source_kind, a.tier], ['votehub', 'free']);
eq('approval: poll_type/subject', [a.poll_type, a.subject], ['approval', 'Donald Trump']);
eq('approval: pollster', a.pollster, 'InsiderAdvantage');
eq('approval: population passthrough (fills frame gap)', a.population, 'rv');
eq('approval: sample_size', a.sample_size, 800);
eq('approval: moe null (VoteHub omits)', a.moe_pct, null);
eq('approval: dates', [a.start_date, a.end_date], ['2025-01-20', '2025-01-20']);
eq('approval: answers', a.answers, [{ choice: 'Disapprove', pct: 39 }, { choice: 'Approve', pct: 56 }]);
eq('approval: source_id from id', a.source_id, 'votehub-appdoninsm57hlnce');
eq('approval: is_aggregate false', a.is_aggregate, false);

const s = V.normalizePoll(SENATE);
eq('senate: sponsors joined', s.sponsor, 'GBAO/AARP');
eq('senate: partisan carried', s.partisan, 'R');
eq('senate: internal carried', s.internal, true);
eq('senate: seat_name', s.seat_name, 'Florida Class II');
eq('senate: population lv', s.population, 'lv');

// --- fail-soft ---
eq('garbage → null', V.normalizePoll(GARBAGE), null);
eq('null → null', V.normalizePoll(NULLY), null);
eq('normalizeMany drops bad rows', V.normalizeMany([APPROVAL, GARBAGE, NULLY, SENATE]).length, 2);

// --- URL builder ---
eq('pollsUrl base', V.pollsUrl(), 'https://api.votehub.com/polls');
eq('pollsUrl query', V.pollsUrl({ poll_type: 'approval', subject: 'Donald Trump', limit: 50 }),
  'https://api.votehub.com/polls?poll_type=approval&subject=Donald%20Trump&limit=50');

// --- fetchPolls with MOCK fetchJson (bare array + wrapped forms) ---
(async () => {
  const mock = async (url) => (url.includes('/polls') ? [APPROVAL, SENATE, GARBAGE] : []);
  const r = await V.fetchPolls({ fetchJson: mock, poll_type: 'approval' });
  ok('fetchPolls ok', r.ok === true);
  ok('fetchPolls normalized + dropped garbage', r.polls.length === 2, `got ${r.polls.length}`);

  const wrapped = await V.fetchPolls({ fetchJson: async () => ({ data: [APPROVAL] }) });
  ok('fetchPolls unwraps {data:[…]}', wrapped.polls.length === 1);

  eq('fetchPolls missing fetchJson → ok:false', (await V.fetchPolls({})).ok, false);
  const errCase = await V.fetchPolls({ fetchJson: async () => { throw new Error('HTTP 500'); } });
  ok('fetchPolls fail-soft on throw', errCase.ok === false && /500/.test(errCase.error));

  const pt = await V.fetchPollTypes({ fetchJson: async () => ['approval', 'generic-ballot'] });
  ok('fetchPollTypes', pt.ok && pt.types.length === 2);

  // --- CROSS-ADAPTER shape parity: VoteHub record carries every CORE key the Wikipedia adapter emits ---
  const wikiRec = W.parseTable(
    '<table class="wikitable"><tr><th>Pollster</th><th>Date(s)</th><th>Sample</th><th>Approve</th><th>Disapprove</th></tr>' +
    '<tr><td>Gallup</td><td>July 1, 2026</td><td>1000 (A)</td><td>40%</td><td>55%</td></tr></table>',
    { subject: 'Donald Trump', poll_type: 'approval' }).polls[0];
  const CORE = ['source_kind', 'tier', 'poll_type', 'subject', 'pollster', 'sponsor', 'population',
    'sample_size', 'moe_pct', 'start_date', 'end_date', 'url', 'answers', 'is_aggregate', 'source_id'];
  const missing = CORE.filter((k) => !(k in a) || !(k in wikiRec));
  ok('shared shape: both adapters carry all CORE keys', missing.length === 0, `missing ${JSON.stringify(missing)}`);

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
