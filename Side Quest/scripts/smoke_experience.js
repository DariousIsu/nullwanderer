/**
 * Backtest — experience layer + provenance markers.
 *  - recordProcedure stores a how-to in the capability track WITH a provenance marker
 *  - a confirmed duplicate is SKIPPED (deduped), not re-stored
 *  - resolveMarker turns a marker back into the RAW source row (reference-not-copy)
 *  - captureActionOutcome distills a procedure (injected synth) + attaches provenance
 * Temp DB, real bge-small; decideFn/synthFn injected so no model needed.
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\smoke_experience.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_exp_${Date.now()}.db`);

const D = require('../lib/db');
D.init();
const memory = require('../lib/memory');
const experience = require('../lib/experience');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

(async () => {
  await memory.warm().catch(() => {});

  // a raw reading exists in monologue — the provenance marker will point at it
  const rd = D.insertMonologue({ content: 'I read the Purdue OWL page on sentence clarity.', model: 'web-read', type: 'reading', query: 'https://owl.purdue.edu/...', urls: JSON.stringify(['https://owl.purdue.edu/owl/general_writing/mechanics/sentence_clarity.html']) });
  const mk = experience.marker('reading', { refTable: 'monologue', refId: rd.id, url: 'https://owl.purdue.edu/owl/general_writing/mechanics/sentence_clarity.html', label: 'Purdue OWL sentence clarity' });

  const neverDup = async () => false;
  const alwaysDup = async () => true;

  const a = await experience.recordProcedure({ content: 'To write a clear sentence, keep it to one main idea.', kind: 'skill', provenance: mk, decideFn: neverDup });
  ok('procedure stored (add)', a && a.action === 'add' && a.id);

  // stored row carries provenance
  const row = D.getKnowledgeByIds([a.id])[0];
  const prov = row && row.provenance ? JSON.parse(row.provenance) : null;
  ok('row holds provenance marker', !!(prov && prov[0] && prov[0].refId === rd.id));
  ok('marker records source kind/url', !!(prov[0].type === 'reading' && /purdue/i.test(prov[0].url)));

  // duplicate (LLM says same) → skip, no new row
  const before = D.countKnowledge();
  const b = await experience.recordProcedure({ content: 'Keep each sentence focused on a single idea for clarity.', kind: 'skill', provenance: mk, decideFn: alwaysDup });
  ok('confirmed duplicate is SKIPPED', b && b.action === 'skip');
  ok('no new row added on dup', D.countKnowledge() === before);

  // resolveMarker → raw source row (reference-not-copy proof)
  const resolved = experience.resolveMarker(prov[0]);
  ok('resolveMarker fetches the RAW monologue row', !!(resolved && resolved.raw && /Purdue OWL/i.test(resolved.raw.content)));
  ok('resolveMarker surfaces the url', /purdue/i.test(resolved.url || ''));

  // captureActionOutcome with injected synth
  const synthFn = async () => 'To reply to an email: open a draft, write the body, then send the staged tags in order.';
  const c = await experience.captureActionOutcome({ name: 'email-reply', task: 'reply to an email', success: true, provenance: experience.marker('email', { to: 'x@y.com', label: 'email reply' }), synthFn });
  ok('captureActionOutcome records a procedure', c && c.action === 'add');
  const crow = D.getKnowledgeByIds([c.id])[0];
  ok('action procedure carries email provenance', !!(crow && crow.provenance && /email/.test(crow.provenance)));

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { D.getDb().close(); } catch {}
  try { fs.unlinkSync(process.env.SQ_DB_PATH); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
