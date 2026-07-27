/* Smoke: BOOT-GRACE (cold-boot stutter mitigation, Layer 5) — source assertions on main.js.
 *
 * Boot-grace is a runtime timer behavior (no pure unit surface), so this guards the WIRING: the helper
 * exists, is env-tunable, and — critically — is applied to EVERY heavy catch-up lane. The governor (#15)
 * regressed exactly this way (wired to only 2 of its lanes), so each lane's guard is asserted by name.
 * Run: node scripts/smoke_boot_grace.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

ok(/const _bootAt = Date\.now\(\);/.test(src), 'boot timestamp captured at module load');
ok(/const BOOT_GRACE_MS = \(parseFloat\(process\.env\.ZOE_BOOT_GRACE_SEC\)/.test(src),
  'grace window is env-tunable (ZOE_BOOT_GRACE_SEC) and disable-able (0 = off)');
ok(/function _bootGraceActive\(\) \{ return BOOT_GRACE_MS > 0 && \(Date\.now\(\) - _bootAt\) < BOOT_GRACE_MS; \}/.test(src),
  'the helper is a one-time boot window (steady-state behavior unchanged)');

// EVERY heavy catch-up lane must hold during the grace — the anti-#15-regression assertion.
for (const lane of ['curation', 'audit', 'ingest', 'kg-dedup', 'decomp-sweep']) {
  const re = new RegExp(`if \\(_bootGraceActive\\(\\)\\) \\{ _logBootDefer\\('${lane.replace('-', '\\-')}'\\); return; \\}`);
  ok(re.test(src), `heavy lane "${lane}" is held during boot-grace`);
}

// decomp-sweep keeps BOTH guards (boot-grace AND the live-conversation governor) — they are orthogonal.
ok(/_logBootDefer\('decomp-sweep'\); return; \}[\s\S]{0,140}_logLoadDeferral\('decomp-sweep'\)/.test(src),
  'decomp-sweep holds for BOTH boot-grace and live-conversation (orthogonal windows)');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
