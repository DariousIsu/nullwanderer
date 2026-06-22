/** LIVE smoke — Echo Suit over HTTP (the production attach path). Requires Echo's HTTP server
 *  running on :8765 (python -m echo.mcp_server --transport http). Reads the admin token from
 *  config.toml exactly like main.js. Verifies fromEnv/httpTransport against REAL FastMCP. */
const fs = require('fs'), path = require('path');
const ECHO_CWD = 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
function readEchoConfig(dir) {
  let token = null, port = 8765;
  try { const toml = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8');
    const m = toml.match(/^\s*admin_token\s*=\s*"([^"]+)"/m); if (m) token = m[1];
    const p = toml.match(/^\s*port\s*=\s*(\d+)/m); if (p) port = parseInt(p[1], 10); } catch {}
  return { url: `http://127.0.0.1:${port}/mcp/`, token };
}
const echo = require('../lib/echo');
const S = require('../lib/echo_suit');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n); } };

(async () => {
  const cfg = readEchoConfig(ECHO_CWD);
  console.log('attaching to', cfg.url, '(token', cfg.token ? 'present' : 'MISSING', ')');
  const suit = S.createSuit({ client: echo.fromEnv({ url: cfg.url, token: cfg.token }) });
  try {
    const r = await suit.connect();
    ok(`HTTP connect ok (${r.tools} tools)`, r.ok === true);
    ok('full surface (~518)', suit.status().tools > 400);
    ok('suit-context block built (contract+atlas)', !!suit.suitContextBlock() && /atlas/i.test(suit.suitContextBlock()));
    const find = await suit.dispatch({ kind: 'find', query: 'search knowledge' });
    ok('find over HTTP returns tools', find.ok && /search/i.test(find.text));
    const dbmap = await suit.dispatch({ kind: 'do', name: 'get_db_map', args: { detail: 'overview' } });
    ok('do(get_db_map) over HTTP', dbmap.ok && /databases|civic|table/i.test(dbmap.text));
    // admin-tier write path: a propose call should be ACCEPTED (not auth-rejected). We don't
    // assert it persists — just that admin token reaches a write tool without a 401/scope error.
    const prop = await suit.dispatch({ kind: 'do', name: 'describe_tool', args: { name: 'propose_entity' } });
    ok('admin token reaches write-tool surface (describe propose_entity)', prop.ok && /propose/i.test(prop.text));
    console.log('\n' + (fail === 0 ? 'HTTP LIVE: ALL PASS' : 'HTTP LIVE: FAILURES') + ` - ${pass} passed, ${fail} failed`);
  } catch (e) { console.log('HTTP SMOKE THREW:', e.message); fail++; }
  finally { try { await suit.close(); } catch {} setTimeout(() => process.exit(fail === 0 ? 0 : 1), 300); }
})();
