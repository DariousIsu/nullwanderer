/**
 * Drive the FINALIZE conductor (lib/paper_finalize) on a topic — the program producing a finished
 * document: ONE file, frozen outline, inline [n] citations, full source list. This script is the
 * same call the artifact router will make; running it IS the program doing its job.
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\finalize_paper.js "applied digital" "goal text"
 */
const topic = process.argv[2] || 'applied digital';
const goal = process.argv[3] || `A complete, sourced research paper on ${topic}.`;
const pf = require('../lib/paper_finalize');
const ollama = require('../lib/ollama');
const config = require('../lib/config');

(async () => {
  try { require('../lib/db').init(); } catch {}   // doc_store.land needs the store open
  // MODEL CHAIN (08-13, run 2: think:false reaches the request body but the -cloud endpoint
  // ignored it for gpt-oss — 7/10 sections died to salvaged chain-of-thought). Mirror the reply
  // writer's proven fallback: try writers in order, take the first NON-CoT body per section.
  const chain = [...new Set([process.env.ZOE_PAPER_MODEL, 'gemma4:31b-cloud', 'kimi-k2.6', config.deepReasonerModel()].filter(Boolean))];
  console.log(`[finalize] topic="${topic}" writer chain: ${chain.join(' → ')}`);
  const COT_SNIFF = /^\s*(?:We (?:need|must|should|have to)|Let'?s|The (?:instruction|user|task))\b/i;
  const write = async (prompt) => {
    for (const model of chain) {
      try {
        const t = String(await ollama.complete({
          model,
          messages: [{ role: 'user', content: prompt }],
          options: { temperature: 0.4, num_predict: 900 },
          lane: 'directed',           // Lucas-demanded work — the honest tier
          think: false,
          timeoutMs: 240000,
        }) || '');
        if (t.trim().length > 80 && !COT_SNIFF.test(t)) return t;
        console.warn(`[finalize] ${model}: unusable body (${t.trim().length} chars${COT_SNIFF.test(t) ? ', CoT-shaped' : ''}) — next writer`);
      } catch (e) { console.warn(`[finalize] ${model} failed: ${e.message} — next writer`); }
    }
    return '';
  };
  const t0 = Date.now();
  // Entity-scope veto: the CRM's near-duplicate accounts (the Florida VeriChip-era "Applied
  // Digital Solutions") match the topic tokens; the caller names what is NOT the subject.
  const exclude = (process.env.ZOE_PAPER_EXCLUDE || 'solutions inc,digital angel,verichip').split(',').map((s) => s.trim()).filter(Boolean);
  const r = await pf.finalize({ topic, goal, write, exclude });
  if (!r.ok) { console.error(`[finalize] FAILED: ${r.reason}`); process.exit(1); }
  // STYLED OUTPUT (Lucas 08-13): a finished paper is not raw markdown — render the .docx twin via
  // the same converter the papers pipeline uses. The docx sits beside the canonical .md.
  try {
    const fs = require('fs');
    const md = fs.readFileSync(r.path, 'utf8');
    const buf = await require('../lib/md_to_docx').buildDocxBuffer({ title: '', markdown: md });
    const docxPath = r.path.replace(/\.md$/, '.docx');
    fs.writeFileSync(docxPath, buf);
    console.log(`[finalize] styled twin: ${docxPath} (${buf.length} bytes)`);
  } catch (e) { console.warn(`[finalize] docx render failed (md stands): ${e.message}`); }
  console.log(`[finalize] DONE in ${Math.round((Date.now() - t0) / 1000)}s — ${r.sections} sections, ${r.sourceCount} sources, ${r.fragments} fragments folded`);
  console.log(`[finalize] THE document: ${r.path}`);
  process.exit(0);
})().catch((e) => { console.error('[finalize] crashed:', e.message); process.exit(1); });
