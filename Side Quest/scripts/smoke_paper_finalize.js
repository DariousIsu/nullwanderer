/**
 * Finalize conductor — the document false-loop cure. Deterministic stages proven on synthetic
 * fragments; the write pass injected. Pins: frozen outline, source harvest, [n] validation,
 * ONE canonical output file (re-finalize overwrites, never siblings).
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\smoke_paper_finalize.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_pfin_${Date.now()}.db`);
require('../lib/db').init();
const pf = require('../lib/paper_finalize');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

const dir = path.join(os.tmpdir(), `pfin_frags_${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'acme_widgets_overview.md'),
  '# Acme Widgets Overview\n\nAcme builds widgets in [Springfield](https://acme.example/plants). Revenue grew 40%.\n\n## Community Impact\nAcme funds the library (https://springfield.example/library).\n');
fs.writeFileSync(path.join(dir, 'directed-9-dossier.md'),
  '# Research deliverable — acme widgets financing\n\n# Research plan\n\n## Financing\nAcme raised $2B ([SEC filing](https://sec.example/acme-10k)).\n\n## Community Impact Notes\nThe plant employs 300 people.\n');
fs.writeFileSync(path.join(dir, 'unrelated_topic.md'), '# Something Else\nNo acme here at all, different subject entirely.\n');

// gather: token-matched only
const frags = pf.gatherFragments({ tokens: ['acme', 'widgets'], dir });
ok('gather finds both acme fragments, skips the unrelated file', frags.length === 2 && !frags.some((f) => f.file === 'unrelated_topic.md'));

// sources: unique + numbered, markdown links keep titles
const srcs = pf.harvestSources(frags);
ok('harvest numbers every unique URL (3)', srcs.length === 3 && srcs[0].n === 1);
ok('markdown link titles carried', srcs.some((s) => s.title === 'SEC filing'));

// outline: boilerplate dropped, near-dup headings merged, frozen
const heads = pf.outline(frags);
ok('boilerplate headings dropped (no "Research plan")', !heads.some((h) => /research plan|research deliverable/i.test(h)));
ok('near-dup headings merged ("Community Impact" once)', heads.filter((h) => /community impact/i.test(h)).length === 1);

// assemble: [n] validation strips out-of-range markers; source list appended
const doc = pf.assemble({
  title: 'T', goal: 'G', sources: srcs, dateStr: 'today',
  sections: [{ heading: 'A', body: 'Real claim [1]. Ghost claim [9]. Another [3].' }, { heading: 'B', body: 'Plain text.' }],
});
ok('valid [n] kept, out-of-range [9] stripped', doc.includes('[1]') && doc.includes('[3]') && !doc.includes('[9]'));
ok('the full source list is in the document', doc.includes('## Sources') && doc.includes('1. ') && doc.includes('3. '));

(async () => {
  // finalize end-to-end with an injected writer — ONE canonical file
  const write = async (p) => `Body for this section citing the filing [2] and the plant page [1]. ${'x'.repeat(80)}`;
  const r1 = await pf.finalize({ topic: 'acme widgets', goal: 'test paper', write, dir, outDir: dir, land: false });
  ok('finalize → ok with sections + sources counted', r1.ok && r1.sections >= 3 && r1.sourceCount === 3);
  ok('THE file exists and carries inline citations + Sources', (() => { const t = fs.readFileSync(r1.path, 'utf8'); return /\[2\]/.test(t) && /## Sources/.test(t); })());

  const r2 = await pf.finalize({ topic: 'acme widgets', goal: 'test paper', write, dir, outDir: dir, land: false });
  ok('re-finalize OVERWRITES the same canonical file (no siblings)', r2.path === r1.path
    && fs.readdirSync(dir).filter((f) => f.endsWith('_FINAL.md')).length === 1);

  const r3 = await pf.finalize({ topic: 'zzz nothing', write, dir, outDir: dir, land: false });
  ok('no fragments → honest failure, no file', r3.ok === false && /no fragments/.test(r3.reason));

  const r4 = await pf.finalize({ topic: 'acme widgets', write: async () => '', dir, outDir: dir, land: false });
  ok('a dead writer → honest failure (never a hollow document)', r4.ok === false);

  // the first live run's poison: salvaged chain-of-thought as body text → REJECTED per section
  const r5 = await pf.finalize({ topic: 'acme widgets', write: async () => 'We need to write the section using the numbered source list. The instruction says every claim must cite. ' + 'x'.repeat(100), dir, outDir: dir, land: false });
  ok('chain-of-thought bodies are REJECTED (honest failure, never a poisoned paper)', r5.ok === false);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { require('../lib/db').getDb().close(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  try { fs.unlinkSync(process.env.SQ_DB_PATH); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
