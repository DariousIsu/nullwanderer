/**
 * LIVE-FIRE Super Search against the RUNNING engine + REAL local 24B + REAL cloud frontier —
 * without restarting Zoe. Exercises the exact runSuperSearch pathway the "search:run" IPC calls:
 * plan (local) → retrieve BOTH lanes (real search_knowledge/entities/contacts/bills/polls +
 * academic_search + Zoe's DDG web search + web_extract body) → rerank (local) → cited overview
 * (CLOUD). ingestMode 'none' so it never writes to the owned corpus (ingest is smoke-proven).
 *
 * Run (Electron ABI keeps parity with the app's native modules):
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/livefire_super_search.js
 */
const path = require('path');
const fs = require('fs');
const echoLib = require('./../lib/echo');
const { complete } = require('../lib/ollama');
const config = require('../lib/config');
const ssRun = require('../studio/super_search_run');
const ssModelIO = require('../studio/super_search_model_io');
const webSearch = require('../lib/web_search').search;

function echoCfg() {
  const dir = process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
  let token = process.env.NX_ECHO_ADMIN_TOKEN || null, port = 8765;
  try {
    const toml = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8');
    if (!token) { const m = toml.match(/^\s*admin_token\s*=\s*"([^"]+)"/m); if (m) token = m[1]; }
    const p = toml.match(/^\s*port\s*=\s*(\d+)/m); if (p) port = parseInt(p[1], 10);
  } catch (e) {}
  return { url: process.env.ECHO_MCP_URL || `http://127.0.0.1:${port}/mcp/`, token };
}

(async () => {
  const cfg = echoCfg();
  console.log(`[livefire] engine MCP: ${cfg.url} (token ${cfg.token ? 'present' : 'MISSING'})`);
  const client = echoLib.fromEnv({ url: cfg.url, token: cfg.token });
  // recipes want the domain payload, not the MCP {content:[…]} envelope → unwrap at the boundary.
  const callTool = async (n, a) => echoLib.toolJson(await client.callTool(n, a));
  const model = config.model();

  const ECHO_CWD = process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
  const ECHO_PYTHON = process.env.ECHO_PYTHON || path.join(ECHO_CWD, '.venv', 'Scripts', 'python.exe');
  require('../lib/keystore').hydrateFromEcho(['OLLAMA_API_KEY'], { python: ECHO_PYTHON, cwd: ECHO_CWD });
  const modelsLib = require('../lib/models');
  const cloud = modelsLib.sources().find(s => s.tier === 'cloud' && s.token);
  const cloudModel = process.env.AGENT_MODEL_ON_DEMAND_BACKGROUND || 'gemma4:31b-cloud';
  console.log(`[livefire] plan/rerank: local ${model} · overview: ${cloud ? 'CLOUD ' + cloudModel + ' @ ' + cloud.base : 'local ' + model}`);

  const planner = ssModelIO.makePlanner({ complete, model });
  const reranker = ssModelIO.makeReranker({ complete, model });
  const overview = ssModelIO.makeOverview(cloud
    ? { complete, model: cloudModel, base: cloud.base, headers: { Authorization: `Bearer ${cloud.token}` } }
    : { complete, model });

  const query = process.argv[2] || 'does cloud seeding actually increase snowpack';
  console.log(`[livefire] query: "${query}"`);

  const t0 = Date.now();
  const run = await ssRun.runSuperSearch(query, {
    recipeDeps: { callTool, search: (q) => webSearch(q) },
    planner, reranker, overview,
    ingestMode: 'none',   // never touch the real corpus in a test
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n[livefire] completed in ${dt}s`);
  console.log('--- plan ---', JSON.stringify(run.plan));
  console.log(`--- INTERNAL lane (${run.internal.length}) ---`);
  for (const c of run.internal.slice(0, 8)) console.log(`  [${c.rank}] ${c.source}: ${(c.title || '').slice(0, 64)} {${Object.keys(c.enrich || {}).join(',')}}`);
  console.log(`--- EXTERNAL lane (${run.external.length}) ---`);
  for (const c of run.external.slice(0, 8)) console.log(`  [${c.rank}] ${c.source}: ${(c.title || '').slice(0, 64)} ${c.url || ''}`);
  console.log('--- OVERVIEW (cloud, cite_floor) ---');
  console.log(`  rendered=${run.overview.rendered}`);
  if (run.overview.rendered) { console.log(`  answer: ${run.overview.answer}`); console.log(`  citations: ${run.overview.citations.map(c => `[${c.n}] ${c.cite}`).join(' · ')}`); }
  console.log('--- stats ---', JSON.stringify(run.stats));
  process.exit(0);
})().catch(e => { console.error('[livefire] FAILED:', e && e.stack || e); process.exit(1); });
