/* scripts/probe_president.js — AUDIT: "who is the president of the United States?" answered stale "Joe Biden".
 * Traces the real turn path (recall → answerGrounded) with an ask-spy so we see, at each draft, the grounding
 * the cloud received + what it returned — and whether the currency-verify fresh-check even fired / carried Trump.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/probe_president.js
 */
const fs = require('fs'); const path = require('path');
const SQ = path.resolve(__dirname, '..'); process.chdir(SQ);
process.env.SQ_DB_PATH = process.env.SQ_DB_PATH || path.join(SQ, 'data', '_probe_pres.db');
const ECHO_CWD = process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
const L = (s) => console.log(s);

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
  const mention = require(path.join(SQ, 'lib', 'mention'));

  const Q = 'who is the president of the United States?';
  L(`\nQ: ${Q}`);
  L(`_CURRENCY_RE match: ${/\b(current(ly)?|now(adays)?|today|latest|recently|these days|right now|as of|this (?:week|month|year)|who is the)\b/i.test(Q)}`);

  // 1) what does mention detection + recall resolve?
  let men = null; try { men = await mention.detectMention(Q, { context: '' }); } catch (e) { L('mention ERR ' + e.message); }
  L(`mention: ${JSON.stringify(men)}`);
  const r = await ar.recall(Q, { k: 3 });
  L(`recall object: ${r.object ? (r.object.name + ' #' + r.object.id + ' deg=' + r.object.degree + ' [' + r.object.type + '/' + (r.object.subtype || '') + ']') : '∅'}`);
  const objLines = ar._objectLines(r.object).join('\n');
  L(`object grounding lines:\n${objLines ? objLines.split('\n').map(x => '    ' + x).join('\n').slice(0, 600) : '    (none)'}`);

  // 2) what does the fresh wiki check return for the topic the currency-verify would use?
  const topic = String((r.object && r.object.name) || Q).replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, '').trim();
  L(`\ncurrency-verify topic would be: "${topic}"`);
  try { const w = await cog._enrichWiki(topic, {}); L(`  _enrichWiki(topic): ${String(w.text || '(empty)').replace(/\s+/g, ' ').slice(0, 240)}`); L(`  → mentions Trump:${/trump/i.test(w.text || '')}  Biden:${/biden/i.test(w.text || '')}`); } catch (e) { L('  wiki ERR ' + e.message); }

  // 3) run the real answerGrounded with an ask-spy
  let n = 0;
  const spyAsk = async (a) => {
    if (a && a.task === 'answer_or_need' && a.input) {
      n++;
      const g = String(a.input.grounding || '');
      const out = await cloud.ask(a);
      L(`  draft #${n}: grounding=${g.length}ch [Trump:${/trump/i.test(g)} Biden:${/biden/i.test(g)}] → ${String(out).replace(/\s+/g, ' ').slice(0, 120)}`);
      return out;
    }
    return cloud.ask(a);
  };
  const grounding = ad.factualGrounding({ knowledgeBlock: objLines });
  L(`\n── answerGrounded trace ──`);
  const res = await cog.answerGrounded({ userMessage: Q, grounding, object: r.object, deps: { ask: spyAsk } });
  L(`\nRESULT: enriched=${res && res.enriched} src=${res && res.enrichSource} missed=${res && res.missed}`);
  L(`SAY: ${res && String(res.say).replace(/\s+/g, ' ')}`);
  await suit.close(); process.exit(0);
})().catch(e => { L('ERR ' + e.message + '\n' + e.stack); process.exit(1); });
