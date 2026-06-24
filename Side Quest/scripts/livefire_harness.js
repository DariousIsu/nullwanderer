/**
 * LIVE-FIRE the deterministic verification harness against the RUNNING engine + REAL local model
 * + REAL bge-small embedder — without restarting Zoe. Exercises the exact editor_checks.runHarness-
 * Checks path the "Run checks" button calls (docId:null → no registry write, no workspace impact).
 *
 * Proves, end to end and live: extract → resolve (real web_fetch/web_search via Echo) → match
 * (real embeddings) → preflight (real cheap-model homework-check) → classify (real local 24B) →
 * standardized contract output.
 *
 * Run (Electron ABI for better-sqlite3 + transformers.js):
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/livefire_harness.js
 */
const path = require('path');
const fs = require('fs');
const echoLib = require('../lib/echo');
const { complete } = require('../lib/ollama');
const memory = require('../lib/memory');
const config = require('../lib/config');
const { importText } = require('../lib/editor_import');
const editorChecks = require('../lib/editor_checks');

function echoCfg() {
  const dir = process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
  let token = process.env.NX_ECHO_ADMIN_TOKEN || null, port = 8765;
  try {
    const toml = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8');
    if (!token) { const m = toml.match(/^\s*admin_token\s*=\s*"([^"]+)"/m); if (m) token = m[1]; }
    const p = toml.match(/^\s*port\s*=\s*(\d+)/m); if (p) port = parseInt(p[1], 10);
  } catch (e) { /* fall back to defaults */ }
  return { url: process.env.ECHO_MCP_URL || `http://127.0.0.1:${port}/mcp/`, token };
}

// A small live-fire doc: a quote tied to a REAL fetchable URL, a numeric claim (search path),
// and a deliberately unsupported claim (should resolve Unsupported / route to the model).
const DOC = [
  '# Live-fire verification probe',
  '',
  'According to its encyclopedia entry, "Mistral AI is a French artificial intelligence" company headquartered in Paris. See https://en.wikipedia.org/wiki/Mistral_AI for the full profile.',
  'The company was reported to have raised over $600 million in a funding round.',
  'Mistral AI operates a chain of deep-sea lighthouses across the Pacific seabed.',
].join('\n');

(async () => {
  const cfg = echoCfg();
  console.log(`[livefire] engine MCP: ${cfg.url} (token ${cfg.token ? 'present' : 'MISSING'})`);
  const client = echoLib.fromEnv({ url: cfg.url, token: cfg.token });
  const callTool = (n, a) => client.callTool(n, a);
  const model = config.model();
  console.log(`[livefire] local classify/homework model: ${model}`);

  console.log('[livefire] warming bge-small embedder…');
  await memory.warm();

  const wc = importText(DOC, { format: 'md' });
  console.log(`[livefire] working copy: ${wc.blocks.length} blocks`);

  const t0 = Date.now();
  const res = await editorChecks.runHarnessChecks({
    callTool, workingCopy: wc, complete, docId: null,
    localModel: model, embed: memory.embed, cosine: memory.cosine,
    onStage: (name, payload) => console.log(`  [stage] ${name}:`, JSON.stringify(payload)),
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n[livefire] completed in ${dt}s`);
  console.log('--- resolution ---');
  for (const r of res.stages.resolved) {
    console.log(`  ${r.uid}: tier=${r.tier} resolved=${r.resolved} src_len=${(r.source_text || '').length}${r.source_url ? ' ' + r.source_url : ''}`);
  }
  console.log('--- match bands ---');
  for (const m of res.stages.matched) console.log(`  ${m.uid}: ${m.band} score=${m.match_score} tier=${m.tier}`);
  console.log('--- preflight gate ---');
  console.log(`  proceed=${res.gate.proceed} reason="${res.gate.reason}"`);
  if (res.gate.sample && res.gate.sample.verdicts) for (const v of res.gate.sample.verdicts) console.log(`    homework ${v.uid}: ok=${v.ok} ${v.reason || ''}`);
  console.log('--- classify (residue) ---');
  for (const c of res.stages.classified) console.log(`  ${c.uid}: ${c.status_code} tier=${c.tier} conf=${c.confidence} note="${(c.note || '').slice(0, 80)}"`);
  console.log('--- FINAL findings (contract render model) ---');
  for (const f of res.mapped.findings) console.log(`  [${f.verdict.toUpperCase()}] ${f.vlabel} — "${(f.label || '').slice(0, 70)}"`);
  console.log('--- summary ---', JSON.stringify(res.mapped.summary));

  process.exit(0);
})().catch(e => { console.error('[livefire] FAILED:', e && e.stack || e); process.exit(1); });
