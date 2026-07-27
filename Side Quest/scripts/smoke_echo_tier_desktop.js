/* Smoke: echo_tier DESKTOP-CONTROL carve on the AUTONOMOUS loop (operator-authorized 2026-07-27).
 *
 * echo_tier.allowedOnAuto() now admits os_* (perception + actuation) and gui_do on the autonomous loop,
 * in ADDITION to read/propose. This pins the carve so it can never silently widen: the two
 * self-escalation tools (os_set_policy, os_approval_resolve) MUST stay excluded, ordinary Echo writes
 * MUST stay blocked on the auto-loop, and read/propose MUST still pass. Pure — no live Echo.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_echo_tier_desktop.js
 */
'use strict';
const tier = require('../lib/echo_tier');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- desktop control ADMITTED on the autonomous loop ---
for (const t of ['os_click', 'os_send_keys', 'os_launch_app', 'os_move', 'os_scroll', 'os_read_focused_text', 'gui_do']) {
  ok(tier.allowedOnAuto(t) === true, `auto-loop MAY use desktop tool "${t}"`);
}

// --- the two self-escalation tools are DELIBERATELY EXCLUDED (auto-loop cannot widen its own authority) ---
ok(tier.allowedOnAuto('os_set_policy') === false, 'auto-loop CANNOT use os_set_policy (self-escalation excluded)');
ok(tier.allowedOnAuto('os_approval_resolve') === false, 'auto-loop CANNOT use os_approval_resolve (self-escalation excluded)');

// --- ordinary Echo WRITES are still blocked on the auto-loop (the carve is desktop-only, not blanket write) ---
for (const w of ['merge_entities', 'delete_relation', 'update_contact', 'promote_proposal']) {
  ok(tier.allowedOnAuto(w) === false, `auto-loop still BLOCKED from Echo write "${w}"`);
}

// --- read + propose still pass (carve is additive, not a replacement) ---
ok(tier.allowedOnAuto('search_entities') === true, 'auto-loop still MAY read (search_entities)');
ok(tier.allowedOnAuto('propose_entity') === true, 'auto-loop still MAY propose (propose_entity)');

// --- interactive turns are unaffected: os_* still classifies as write (full access on a live turn) ---
ok(tier.classifyTool('os_click') === 'write', 'os_click still classifies as write (interactive turns unchanged)');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
