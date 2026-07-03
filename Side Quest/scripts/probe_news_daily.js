/* scripts/probe_news_daily.js — DIAGNOSTIC: does the news daily pass's event-object promotion actually work,
 * or has it simply never fired? Runs the real proposeEventObject (propose_entity) + a sample involves edge
 * against LIVE Echo, on a few worthy stories, with an instrumented dispatch. Reads the bucket READ-ONLY.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/probe_news_daily.js
 */
const fs = require('fs'); const path = require('path');
const SQ = path.resolve(__dirname, '..'); process.chdir(SQ);
const ECHO_CWD = process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
const L = (s) => console.log(s);

(async () => {
  let token = null, port = 8765;
  try { const t = fs.readFileSync(path.join(ECHO_CWD, 'config.toml'), 'utf8'); const m = t.match(/admin_token\s*=\s*"([^"]+)"/); if (m) token = m[1]; } catch {}
  const es = require(path.join(SQ, 'lib', 'echo_suit')), echo = require(path.join(SQ, 'lib', 'echo'));
  const suit = es.createSuit({ client: echo.fromEnv({ url: `http://127.0.0.1:${port}/mcp/`, token }) });
  const c = await suit.connect(); L('echo: ' + (c.ok ? c.tools + ' tools' : 'FAIL')); if (!c.ok) process.exit(0); es.setLiveSuit(suit);
  const news = require(path.join(SQ, 'lib', 'news_lane'));

  // instrument the dispatch so we SEE the propose_entity/propose_relation request + raw response
  const raw = (t) => suit.dispatch(t);
  const dispatch = async (t) => {
    const r = await raw(t);
    if (/propose_entity|propose_relation/.test(t.name)) {
      L(`    → ${t.name}(${JSON.stringify(t.args).replace(/\s+/g, ' ').slice(0, 100)})  ok=${r && r.ok}  :: ${String(r && r.text).replace(/\s+/g, ' ').slice(0, 200)}`);
    }
    return r;
  };

  // read worthy stories READ-ONLY from the bucket (mirror storiesForDaily's filter; no schema writes)
  const D = require('better-sqlite3');
  const bucket = new D(path.join(SQ, 'data', 'news_bucket.db'), { readonly: true, fileMustExist: true });
  const stories = bucket.prepare(
    "SELECT id,title,summary,source_count FROM news_stories WHERE source_count>=1 AND (status='open' OR status='closed') ORDER BY source_count DESC, last_ts DESC LIMIT 5"
  ).all();
  bucket.close();
  L(`worthy stories sampled: ${stories.length}\n`);

  let evOk = 0, edgeOk = 0;
  for (const s of stories) {
    L(`STORY #${s.id}  src=${s.source_count}  "${String(s.title).slice(0, 74)}"`);
    const ev = await news.proposeEventObject({ dispatch, name: s.title, summary: s.summary });
    L(`  proposeEventObject → ${JSON.stringify(ev)}`);
    if (ev.ok && ev.entityId != null) evOk++;
    // sample one involves edge (event → first proper-noun principal)
    const princ = (String(`${s.title}. ${s.summary || ''}`).match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/g) || [])[0];
    if (princ) { const rr = await dispatch({ kind: 'do', name: 'propose_relation', args: { source_name: String(s.title).slice(0, 200), target_name: princ, relation_type: 'involves' } }); if (rr && rr.ok) edgeOk++; }
    L('');
  }
  L(`RESULT: ${evOk}/${stories.length} stories returned an event entity_id;  ${edgeOk}/${stories.length} involves-edges accepted`);
  L(evOk === stories.length ? '→ proposeEventObject WORKS → 0-events was the pass NEVER FIRING (scheduling), not a code bug.'
    : evOk === 0 ? '→ proposeEventObject FAILS on every story → real code/tool issue (inspect raw propose_entity responses above).'
    : '→ MIXED — inspect which stories failed and why.');
  await suit.close(); process.exit(0);
})().catch(e => { L('ERR ' + e.message + '\n' + e.stack); process.exit(1); });
