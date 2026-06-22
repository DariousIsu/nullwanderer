/** LIVE smoke — Echo Suit against the real spawned Echo (stdio). Verifies the bridge end-to-end
 *  on the actual 518-tool surface. Spawns a python child (~26s boot), no Zoe reboot. */
process.env.ECHO_PYTHON = 'C:/Users/azrae/Desktop/NX ECHO/nx-echo/.venv/Scripts/python.exe';
process.env.ECHO_CWD = 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
const S = require('../lib/echo_suit');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n); } };

(async () => {
  const suit = S.createSuit();
  try {
    const r = await suit.connect();
    ok(`connect ok (${r.bootMs}ms, ${r.tools} tools)`, r.ok === true);
    ok('server is nx-echo', suit.status().server && /echo/i.test(suit.status().server.name));
    ok('tool surface is the full ~518', suit.status().tools > 400);

    const block = suit.suitContextBlock();
    ok('suit-context block built', !!block);
    ok('  carries Echo contract (usage guide)', /README_MCP|NX-ECHO|load this/i.test(block));
    ok('  carries the atlas', /atlas/i.test(block));
    ok('  names the nav tags', /<echo-find>/.test(block) && /<echo-do/.test(block));

    const find = await suit.dispatch({ kind: 'find', query: 'search knowledge' });
    ok('find returns real matching tools', find.ok && /search/i.test(find.text));
    console.log('    find sample:', find.text.split('\n').slice(0, 3).join(' | ').slice(0, 160));

    const dbmap = await suit.dispatch({ kind: 'do', name: 'get_db_map', args: { detail: 'overview' } });
    ok('do(get_db_map) returns the real db map', dbmap.ok && /databases|civic|table/i.test(dbmap.text));

    const describe = await suit.dispatch({ kind: 'do', name: 'describe_tool', args: { name: 'search_knowledge' } });
    ok('do(describe_tool) returns a real schema', describe.ok && /search_knowledge/.test(describe.text));

    const bad = await suit.dispatch({ kind: 'do', name: 'quick_lookup', args: {} });
    ok('missing-arg call surfaces structured error (self-correct path)', bad.isError === true && /validation|required|missing/i.test(bad.text));

    console.log('\n' + (fail === 0 ? 'LIVE: ALL PASS' : 'LIVE: FAILURES') + ` - ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.log('LIVE SMOKE THREW:', e.message);
    fail++;
  } finally {
    try { await suit.close(); } catch {}
    setTimeout(() => process.exit(fail === 0 ? 0 : 1), 400);
  }
})();
