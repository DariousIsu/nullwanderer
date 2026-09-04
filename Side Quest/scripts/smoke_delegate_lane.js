/* smoke_delegate_lane.js — stage 4.5 item 3b (2026-09-04): an Echo delegate bills the CALLER's tier.
 *
 * p286's live rows: bill-tracker runs fired from the app's research lane landed in Echo as its "chat"
 * trigger kind and billed `directed` (unpaced) — the trigger-to-tier law can only see the KIND, not
 * who asked. The app now passes the caller's usage-law tier as the call's `lane` arg on every
 * spawn_agent / spawn_agent_async / delegate_to_* dispatch (lib/lane.delegateLane), and Echo's
 * ChatSpawnTrigger carries it into the run's spend row.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const lane = require('../lib/lane');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

// ── the resolution order: ambient tier → bare autonomous = research → his turn = directed ────────
ok(lane.delegateLane(false) === 'directed', 'outside any run, a non-autonomous dispatch is HIS turn → directed');
ok(lane.delegateLane(true) === 'research', 'outside any run, an explicit autonomous dispatch → research (never ungated)');
ok(lane.delegateLane(undefined) === 'directed', 'no flag, no ambient lane → directed (interactive chat is the only unlabelled caller)');
ok(lane.run({ autonomous: true }, () => lane.delegateLane(undefined)) === 'research', 'a bare-autonomous ambient run → research');
ok(lane.run({ autonomous: true, spendTier: 'idle' }, () => lane.delegateLane(undefined)) === 'idle', 'the orchestrator\'s declared tier wins (idle)');
ok(lane.run({ autonomous: true, spendTier: 'directed' }, () => lane.delegateLane(undefined)) === 'directed', 'his directed focus running autonomously still bills directed (earned by origin)');
ok(lane.run({ autonomous: false, spendTier: 'development' }, () => lane.delegateLane(undefined)) === 'development', 'the pen\'s declared tier rides its delegates (development)');
ok(lane.run({ autonomous: true }, () => lane.delegateLane(false)) === 'research', 'an ambient tier outranks an explicit autonomous:false flag (the run declared it)');

// ── wiring: both dispatch branches in the echo suit fill the lane; an explicit args.lane wins ────
const suit = fs.readFileSync(path.join(__dirname, '..', 'lib', 'echo_suit.js'), 'utf8');
const doRe = suit.match(/if \((\/[^\n]*?\/)\.test\(tag\.name\) && callArgs\.lane == null\)/);
ok(!!doRe, 'the <echo-do> branch fills callArgs.lane for spawn/delegate tools only when absent');
if (doRe) {
  const re = new Function(`return ${doRe[1]}`)();
  const yes = ['spawn_agent', 'spawn_agent_async', 'delegate_to_bill_tracker', 'spawn_workflow', 'team_spawn'];
  const no = ['agent_status', 'get_agent_output', 'list_agents', 'spawn_workflow_x', 'team_status', 'run_pass'];
  ok(yes.every((n) => re.test(n)) && !no.some((n) => re.test(n)), `the lane goes to exactly the tools that accept it (${yes.join(', ')}) — never to a status/list tool`);
}
ok(/callArgs = \{ \.\.\.callArgs, lane: require\('\.\/lane'\)\.delegateLane\(opts\.autonomous\) \}/.test(suit), 'the <echo-do> branch resolves through lib/lane.delegateLane with the dispatch\'s own autonomous flag');
ok(/args\.lane = require\('\.\/lane'\)\.delegateLane\(opts\.autonomous\)/.test(suit) && /callTool\('spawn_agent_async', args\)/.test(suit), 'the <echo-delegate> branch stamps args.lane before spawn_agent_async');

// ── the engine side accepts it (cross-repo pin, read-only): the tools take `lane`, the trigger carries it
const ECHO = process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
try {
  const agentsPy = fs.readFileSync(path.join(ECHO, 'echo', 'mcp', 'external', 'agents.py'), 'utf8');
  const trig = fs.readFileSync(path.join(ECHO, 'echo', 'agents', 'triggers.py'), 'utf8');
  const sd = fs.readFileSync(path.join(ECHO, 'echo', 'mcp', 'external', 'specialist_delegates.py'), 'utf8');
  ok(/def spawn_agent\(name: str, prompt: str, lane: str \| None = None\)/.test(agentsPy) && /canvas_tab: str \| None = None,\r?\n    lane: str \| None = None,\r?\n\) -> dict:/.test(agentsPy), 'Echo: spawn_agent + spawn_agent_async take `lane`');
  ok(/lane: str \| None = None/.test(trig) && /d\["lane"\] = self\.lane/.test(trig), 'Echo: ChatSpawnTrigger carries `lane` (to_dict only when set)');
  ok(/def _handler\(prompt: str, canvas_tab: str \| None = None, lane: str \| None = None\)/.test(sd), 'Echo: every delegate_to_<agent> tool takes `lane`');
} catch (e) { console.log(`  (engine tree not readable here — cross-repo pins skipped: ${e.message})`); }

console.log(`\nsmoke_delegate_lane: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
