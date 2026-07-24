/**
 * Offline smoke for the standardized cert template (studio/cert_template.js) — pure deterministic
 * render from a findings-contract result. No DB, no cloud.
 *
 * Run: node scripts/smoke_cert_template.js
 */
const CT = require('../studio/cert_template');
const { renderCertificate, gradeFor, scorelineOf, kpisOf } = CT;

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

// ---- grade derivation (pure function of verdict counts) --------------------------------------
ok('any bad → hold', gradeFor({ byVerdict: { bad: 2, warn: 1, ok: 3 } }).key === 'hold');
ok('warn but no bad → conditional', gradeFor({ byVerdict: { warn: 2, ok: 5 } }).key === 'conditional');
ok('no bad/warn → clear', gradeFor({ byVerdict: { ok: 4, info: 1 } }).key === 'clear');
ok('hold ruling names the issue count', /2 material issues/.test(gradeFor({ byVerdict: { bad: 2 } }).ruling));
ok('conditional singular revision', /1 revision recommended/.test(gradeFor({ byVerdict: { warn: 1 } }).ruling));
// A legacy byVerdict-only summary still reads sensibly (no `verified` field to lean on).
ok('scoreline tallies (legacy summary)', scorelineOf({ byVerdict: { ok: 3, warn: 2, bad: 1, info: 1 } })
  === '3 verified · 1 not supported · 1 not checked · 2 revisions recommended', scorelineOf({ byVerdict: { ok: 3, warn: 2, bad: 1, info: 1 } }));
// ⭐ TWO AXES (Lucas, 2026-07-23: "just because something has a caveat doesn't mean it shouldn't be
// verified"). A claim its source bore out is VERIFIED even when the wording still needs a note. The
// scoreline used to read the `ok` bucket alone, so the live Arizona op-ed — five claims verified
// against their sources, each with a caveat — printed "0 verified · 7 caveat".
ok('a verified-with-caveat claim COUNTS as verified',
  scorelineOf({ total: 3, verified: 3, verifiedClean: 1, notSupported: 0, unchecked: 0, byVerdict: { ok: 1, warn: 2 } })
    === '3 of 3 verified (2 with caveats) · 2 revisions recommended',
  scorelineOf({ total: 3, verified: 3, verifiedClean: 1, notSupported: 0, unchecked: 0, byVerdict: { ok: 1, warn: 2 } }));
ok('the KPI tile shows the same number the scoreline does',
  kpisOf({ total: 3, verified: 3, verifiedClean: 1, notSupported: 0, unchecked: 0, byVerdict: { ok: 1, warn: 2 } }).verified === 3);
ok('a conditional ruling leads with what stood up',
  /3 of 3 claims verified/.test(gradeFor({ total: 3, verified: 3, verifiedClean: 1, byVerdict: { warn: 2 } }).ruling),
  gradeFor({ total: 3, verified: 3, verifiedClean: 1, byVerdict: { warn: 2 } }).ruling);
ok('caveats never turn into "not supported"',
  kpisOf({ total: 3, verified: 3, verifiedClean: 1, notSupported: 0, unchecked: 0, byVerdict: { ok: 1, warn: 2 } }).notSupported === 0);

// ---- a representative mapped result -----------------------------------------------------------
const mapped = {
  findings: [
    { id: 'f1', label: 'Snowpack rose 15% in treated basins', verdict: 'ok', vlabel: 'Verified', status: 'verified', ev: 'Source states 15%.', locator: 'a1.s0' },
    { id: 'f2', label: 'The program cost $5 billion', verdict: 'bad', vlabel: 'Contradicted', status: 'contradicted', ev: 'Source says $3 billion.', locator: 'a1.s1' },
    { id: 'f3', label: 'Officials described broad benefits', verdict: 'warn', vlabel: 'Verified · paraphrase', status: 'VP', ev: 'Paraphrased.', locator: 'a2.s0' },
    { id: 'f4', label: 'Deep-sea lighthouse network', verdict: 'info', vlabel: 'Inaccessible', status: 'inaccessible', ev: 'No source.', locator: 'a3.s0' },
  ],
  suggestions: [
    { id: 's1', finding: 'f2', loc: 'a1.s1 · "$5 billion"', beforeX: '$5 billion', afterO: '$3 billion', src: 'budget records' },
  ],
  summary: { total: 4, resolved: 1, invalid: 0, byVerdict: { ok: 1, bad: 1, warn: 1, info: 1 } },
};
const doc = { title: 'Wyoming Snowpack Brief', author: 'R. Walker', current_version: 2 };
const html = renderCertificate({ doc, findings: mapped.findings, suggestions: mapped.suggestions, summary: mapped.summary, certNumber: 'CFC-2026-06-24-01', issuedAt: Date.UTC(2026, 5, 24, 12), reaudit: false });

// ---- structural assertions --------------------------------------------------------------------
ok('is a complete HTML doc', /^<!doctype html>/i.test(html) && /<\/html>\s*$/i.test(html));
ok('cert id appears (masthead + seal)', (html.match(/CFC-2026-06-24-01/g) || []).length >= 2);
ok('doc title + author rendered', html.includes('Wyoming Snowpack Brief') && html.includes('R. Walker'));
ok('version shown', /v2/.test(html));
ok('one table row per finding (4 nums)', (html.match(/<td class="num">\d+<\/td>/g) || []).length === 4);
ok('verdict pills mapped (pass/fail/warn/info all present)', /pill pass/.test(html) && /pill fail/.test(html) && /pill warn/.test(html) && /pill info/.test(html));
ok('bad finding → ruling is HOLD', /Hold/.test(html) && /must be corrected/.test(html));
ok('KPIs show the counts', /class="n">4<\/div>/.test(html) /* total */ );
ok('suggestion diff rendered (before→after)', /\$5 billion/.test(html) && /\$3 billion/.test(html) && /diff-a/.test(html));
ok('issued date formatted', /June 24, 2026/.test(html));

// ---- escaping (no injection through labels/evidence) ------------------------------------------
const evil = renderCertificate({
  doc: { title: '<script>alert(1)</script>', author: 'x', current_version: 1 },
  findings: [{ label: '<img src=x onerror=1>', verdict: 'ok', vlabel: 'Verified', ev: '"quoted" & <b>bold</b>' }],
  suggestions: [], summary: { total: 1, byVerdict: { ok: 1 } }, certNumber: 'CFC-2026-06-24-02', issuedAt: Date.now(),
});
ok('html-escapes title/label/evidence', !/<script>alert/.test(evil) && evil.includes('&lt;script&gt;') && evil.includes('&lt;img') && evil.includes('&amp;'));

// ---- empty findings degrade gracefully --------------------------------------------------------
const empty = renderCertificate({ doc: { title: 'Empty', author: 'x' }, findings: [], suggestions: [], summary: { total: 0, byVerdict: {} }, certNumber: 'CFC-2026-06-24-03', issuedAt: Date.now() });
ok('empty → clear grade + no-units note', /No verification units/.test(empty) && /Cleared for publication/.test(empty));

// ---- determinism ------------------------------------------------------------------------------
const h2 = renderCertificate({ doc, findings: mapped.findings, suggestions: mapped.suggestions, summary: mapped.summary, certNumber: 'CFC-2026-06-24-01', issuedAt: Date.UTC(2026, 5, 24, 12), reaudit: false });
ok('identical inputs → identical HTML', h2 === html);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
