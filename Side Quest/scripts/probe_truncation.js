/* scripts/probe_truncation.js — PROVE the enrich-ladder truncation: excavate finds the answer, but the
 * accumulated verbose earlier-tier text pushes it past _draftOrNeed's 4200-char cap so the cloud never sees
 * it. Spies deps.ask to log, at EACH re-draft, the grounding length + whether the answer token survives the
 * 4200-char window the draft actually receives.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/probe_truncation.js
 */
const fs = require('fs'); const path = require('path');
const SQ = path.resolve(__dirname, '..'); process.chdir(SQ);
process.env.SQ_DB_PATH = process.env.SQ_DB_PATH || path.join(SQ, 'data', '_probe_trunc.db');
const ECHO_CWD = process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
const L = (s) => console.log(s);
const CAP = 4200;

(async () => {
  require(path.join(SQ, 'lib', 'db')).init();
  try { require(path.join(SQ, 'lib', 'keystore')).hydrateFromEcho(['OLLAMA_API_KEY'], { python: path.join(ECHO_CWD, '.venv', 'Scripts', 'python.exe'), cwd: ECHO_CWD }); } catch {}
  let token = null, port = 8765; try { const t = fs.readFileSync(path.join(ECHO_CWD, 'config.toml'), 'utf8'); const m = t.match(/admin_token\s*=\s*"([^"]+)"/); if (m) token = m[1]; } catch {}
  const es = require(path.join(SQ, 'lib', 'echo_suit')), echo = require(path.join(SQ, 'lib', 'echo'));
  const suit = es.createSuit({ client: echo.fromEnv({ url: `http://127.0.0.1:${port}/mcp/`, token }) });
  const c = await suit.connect(); L('echo: ' + (c.ok ? c.tools + ' tools' : 'FAIL')); if (!c.ok) process.exit(0); es.setLiveSuit(suit);
  await require(path.join(SQ, 'lib', 'ner')).warm();
  const cloud = require(path.join(SQ, 'lib', 'cloud_logic'));
  const cog = require(path.join(SQ, 'lib', 'cognition'));
  const ad = require(path.join(SQ, 'lib', 'answer_draft')), ar = require(path.join(SQ, 'lib', 'active_recall'));

  const Q = 'Who is the current US Secretary of Defense?';
  const ANSWER_TOKEN = 'hegseth';
  let call = 0;
  // spy: wrap cloud.ask so we see exactly what grounding each _draftOrNeed receives
  const spyAsk = async (a) => {
    if (a && a.task === 'answer_or_need' && a.input) {
      call++;
      const full = String(a.input.grounding || '');
      const seen = full.slice(0, CAP);                       // what _draftOrNeed already sliced (it slices in the input)
      const posFull = full.toLowerCase().indexOf(ANSWER_TOKEN);
      const posSeen = seen.toLowerCase().indexOf(ANSWER_TOKEN);
      L(`  draft #${call}: grounding=${full.length}ch  '${ANSWER_TOKEN}' at ${posFull < 0 ? 'ABSENT' : 'char ' + posFull}  → within-cap:${posSeen >= 0 ? 'YES' : (posFull >= 0 ? 'TRUNCATED-AWAY ✗' : '—')}`);
    }
    return cloud.ask(a);
  };

  const r = await ar.recall(Q, { k: 3 });
  const grounding = ad.factualGrounding({ knowledgeBlock: ar._objectLines(r.object).join('\n') });
  L(`\nQ: ${Q}`);
  const res = await cog.answerGrounded({ userMessage: Q, grounding, object: r.object, deps: { ask: spyAsk } });
  L(`\nRESULT: enriched=${res && res.enriched} src=${res && res.enrichSource} missed=${res && res.missed}`);
  L(`SAY: ${res && String(res.say).replace(/\s+/g, ' ').slice(0, 160)}`);
  L(`\n→ If a draft shows 'TRUNCATED-AWAY', the excavated answer was found but cut by the ${CAP}-char cap = the root.`);
  await suit.close(); process.exit(0);
})().catch(e => { L('ERR ' + e.message + '\n' + e.stack); process.exit(1); });
