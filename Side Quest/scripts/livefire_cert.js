/**
 * LIVE-FIRE the FULL editorial chain end to end: import → harness (real engine + local models) →
 * Certify (B4 issuance + B5 template). Uses an ISOLATED editor.db + temp certsDir so it never
 * touches the real workspace registry. Proves real-run → real-cert without restarting Zoe.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/livefire_cert.js
 */
const os = require('os'), fs = require('fs'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-livecert-'));
process.env.EDITOR_DB_PATH = path.join(tmp, 'editor.db');
const certsDir = path.join(tmp, 'certs');

const echoLib = require('../lib/echo');
const { complete } = require('../lib/ollama');
const memory = require('../lib/memory');
const config = require('../lib/config');
const { importText } = require('../lib/editor_import');
const registry = require('../lib/editor_registry');
const editorChecks = require('../lib/editor_checks');
const { issueCertificate } = require('../lib/editor_cert');

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

const DOC = [
  '# Live-fire cert probe',
  '',
  'According to its encyclopedia entry, "Mistral AI is a French artificial intelligence" company headquartered in Paris. See https://en.wikipedia.org/wiki/Mistral_AI for the full profile.',
  'The company was reported to have raised over $600 million in a funding round.',
  'Mistral AI operates a chain of deep-sea lighthouses across the Pacific seabed.',
].join('\n');

(async () => {
  registry.init();
  const cfg = echoCfg();
  const client = echoLib.fromEnv({ url: cfg.url, token: cfg.token });
  const callTool = (n, a) => client.callTool(n, a);
  const model = config.model();
  await memory.warm();

  const wc = importText(DOC, { format: 'md' });
  const doc = registry.registerDocument({ title: wc.title || 'Live-fire cert probe', author: 'Zoe (live-fire)', format: 'md' });
  registry.saveWorkingCopy(doc.id, doc.current_version, wc);

  // Inherit Echo's cloud key so classify runs on the cloud frontier (too big for local).
  const ECHO_PYTHON = process.env.ECHO_PYTHON || path.join(process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo', '.venv', 'Scripts', 'python.exe');
  const ECHO_CWD = process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
  require('../lib/keystore').hydrateFromEcho(['OLLAMA_API_KEY'], { python: ECHO_PYTHON, cwd: ECHO_CWD });
  const modelsLib = require('../lib/models');
  const cloud = modelsLib.sources().find(s => s.tier === 'cloud' && s.token);
  const cloudModel = process.env.AGENT_MODEL_ON_DEMAND_BACKGROUND || 'gemma4:31b-cloud';

  console.log(`[cert] doc #${doc.id} "${doc.title}" — classify on ${cloud ? 'CLOUD ' + cloudModel : 'local ' + model}…`);
  const run = await editorChecks.runHarnessChecks({
    callTool, workingCopy: wc, complete, docId: doc.id, sourceVersion: doc.current_version,
    author: doc.author,
    classifyModelName: cloud ? cloudModel : model,
    classifyBase: cloud ? cloud.base : null,
    classifyHeaders: cloud ? { Authorization: `Bearer ${cloud.token}` } : null,
    cheapModel: model, embed: memory.embed, cosine: memory.cosine,
  });
  console.log(`[cert] verdicts: ${JSON.stringify(run.mapped.summary.byVerdict)}  (gate: ${run.gate.proceed ? 'released' : 'aborted'})`);

  const cert = issueCertificate({ docId: doc.id, mapped: run.mapped, certsDir, checkRunId: (registry.latestCheckRun(doc.id) || {}).id });

  const after = registry.getDocument(doc.id);
  console.log('\n=== CERTIFICATE ISSUED ===');
  console.log(`  number   : ${cert.certNumber}`);
  console.log(`  grade    : ${cert.grade} (${cert.gradeLabel})`);
  console.log(`  scoreline: ${cert.scoreline}`);
  console.log(`  file     : ${cert.certDocRef}  (${fs.existsSync(cert.certDocRef) ? fs.statSync(cert.certDocRef).size + ' bytes' : 'MISSING'})`);
  console.log(`  doc state: ${after.status}  cert_number=${after.cert_number}`);
  console.log(`  registry : ${registry.listCertificates(doc.id).length} cert row(s)`);
  const html = fs.readFileSync(cert.certDocRef, 'utf8');
  console.log(`  html ok  : masthead=${html.includes('Joseph Rainey Center')} certID=${html.includes(cert.certNumber)} rows=${(html.match(/<td class="num">\d+<\/td>/g) || []).length}`);

  registry.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(0);
})().catch(e => { console.error('[cert] FAILED:', e && e.stack || e); process.exit(1); });
