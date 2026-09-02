/**
 * THE BOOT-PARSE GATE (audit F31): npm test never boots Electron, so a change that is green on
 * every suite but dies at APP BOOT — a syntax error, a deleted/renamed lib module — used to
 * pass the gate; that is exactly the class a self-reboot brings live unattended, and the
 * cycler's double-launch failure ends in downtime. This smoke closes the cheap 90%: every
 * boot-path file must PARSE (vm.Script — no execution), and every './lib/...' module main.js
 * requires must RESOLVE. Runtime-only boot breaks remain the cycler's loud-tee job.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_boot_parse.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

const targets = [
  'main.js', 'preload.js', 'scripts/run_smokes.js',
  ...fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js')).map((f) => `lib/${f}`),
  ...fs.readdirSync(path.join(ROOT, 'renderer')).filter((f) => f.endsWith('.js')).map((f) => `renderer/${f}`),
];
const bad = [];
for (const f of targets) {
  try { new vm.Script(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f }); }
  catch (e) { bad.push(`${f}: ${e.message}`); }
}
ok(bad.length === 0, `⭐ every boot-path file PARSES — ${targets.length} checked${bad.length ? ' — ✗ ' + bad.join(' · ') : ''}`);

const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const reqs = [...new Set([...main.matchAll(/require\('(\.\/lib\/[^']+)'\)/g)].map((m) => m[1]))];
const missing = reqs.filter((r) => { try { require.resolve(path.join(ROOT, r)); return false; } catch { return true; } });
ok(reqs.length > 20 && missing.length === 0, `⭐ every lib module main.js requires RESOLVES — ${reqs.length} checked${missing.length ? ' — ✗ ' + missing.join(', ') : ''}`);

const cycler = fs.readFileSync(path.join(ROOT, 'scripts', 'boot_cycle.py'), 'utf8');
ok(/SELF-REBOOT FAILED/.test(cycler) && /SELF-REBOOT WEDGED/.test(cycler) && /boot_self\.log/.test(cycler),
  'the cycler TEES its fatal outcomes into boot_self.log — where the organ watch looks (a dead app cannot raise its own alarm)');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
