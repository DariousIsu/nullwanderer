/* smoke_security_remediate.js — security self-audit, increment 5.3 (2026-09-04): the REMEDIATION FOLD.
 *
 * Routes open findings to their lanes: a code-fixable config finding → a pen-work thread (she authors the
 * diff, gated); a secret / dependency / runtime / tracked-file finding → ONE aggregated needs card per
 * class (196 CVEs must not become 196 cards). Idempotent: a routed finding moves open→proposed. Driven
 * with injected findings/pen/capabilityNeed, offline.
 */
'use strict';
const R = require('../lib/security_remediate');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

// ── a fixture findings store (id, sig, class, severity, title, evidence, proposed_fix, asset, status) ──
function mkStore(rows) {
  const byId = new Map(rows.map((r) => [r.id, { status: 'open', ...r }]));
  return {
    list: ({ status = null } = {}) => [...byId.values()].filter((f) => !status || f.status === status),
    setStatus: (id, status) => { const f = byId.get(id); if (f) f.status = status; return true; },
    _all: () => [...byId.values()],
  };
}
const mkFinding = (id, cls, sev, title, extra = {}) => ({ id, sig: `${cls}::a${id}::${title}`, class: cls, severity: sev, title, evidence: `${title} — ev`, proposed_fix: extra.fix || 'do the fix', asset: extra.asset || `C:/x/file${id}.js` });

// a realistic spread: 2 code-fixable configs (1 Echo CORS, 1 SQ debug), a tracked-secret config, 3 secrets,
// 196 dependency advisories (2 crit + big high/med), 1 runtime.
const rows = [
  mkFinding(1, 'config', 'medium', 'permissive CORS (wildcard origin) in http_routes.py', { asset: 'C:/Users/azrae/Desktop/NX ECHO/nx-echo/echo/http_routes.py' }),
  mkFinding(2, 'config', 'medium', 'debug inspector / remote debugging flag in browser.js', { asset: 'C:/x/lib/browser.js' }),
  mkFinding(3, 'config', 'high', 'secret-bearing file tracked by git (config.toml)', { asset: 'C:/e/config.toml' }),
  mkFinding(4, 'secret', 'medium', 'secret assignment in config.toml', { asset: 'C:/e/config.toml' }),
  mkFinding(5, 'secret', 'medium', 'secret assignment in a.py', { asset: 'C:/x/a.py' }),
  mkFinding(6, 'secret', 'low', 'secret assignment in test_x.py (test fixture)', { asset: 'C:/x/test_x.py' }),
  mkFinding(7, 'runtime', 'high', 'her service on all interfaces (:9999)', { asset: '0.0.0.0:9999' }),
];
let did = 8;
for (let i = 0; i < 196; i++) { const sev = i < 2 ? 'critical' : (i < 70 ? 'high' : 'medium'); rows.push(mkFinding(did++, 'dependency', sev, `GHSA-${did} in pkg${did}@1.0`, { fix: 'upgrade' })); }

const store = mkStore(rows);
const pens = [], needs = [];
const deps = {
  findings: { list: store.list, setStatus: store.setStatus },
  pen: { seedPenWork: (o) => { pens.push(o); return { ok: true }; } },
  capabilityNeed: { record: (text, o) => { needs.push({ text, born: o.bornFrom }); return { id: needs.length }; } },
};

const res = R.routeOpenFindings({ deps, nowMs: 1000 });

// ── code-fixable configs → pen-work (2: the CORS + the debug inspector) ──────────────────────────
ok(res.pens === 2 && pens.length === 2, `2 code-fixable config findings seed pen-work (${res.pens})`);
ok(pens.some((p) => /permissive CORS/.test(p.ask) && /repo="echo"/.test(p.ask)), 'the Echo CORS fix seeds pen-work WITH the repo="echo" hint');
ok(pens.every((p) => /dismiss the finding rather than changing it/.test(p.ask)), 'every pen-work ask says to dismiss if the use is intended (investigate, never force)');
ok(pens.every((p) => /^security:/.test(p.bornFrom)), 'pen-work is born from the finding (dedup-scoped)');

// ── operator findings → ONE aggregated card per class (bounded) ──────────────────────────────────
ok(needs.length === 3, `three aggregated cards: dependency + secret + runtime (the 2 code-fixable configs went to pen-work, so the config card bucket is empty) (${needs.length})`);
const depCard = needs.find((n) => n.born === 'security:dependency');
ok(!!depCard && /196 dependency advisories/.test(depCard.text) && /2 critical/.test(depCard.text), '196 CVEs become ONE card that names the count + criticals — never 196 cards');
const secCard = needs.find((n) => n.born === 'security:secret');
ok(!!secCard && /ROTATE/.test(secCard.text) && /config\.toml/.test(secCard.text), 'the secrets + the tracked config.toml fold into ONE rotate card');
ok(needs.some((n) => n.born === 'security:runtime'), 'the runtime exposure files a runtime card');
ok(needs.every((n) => /^security:/.test(n.born)), 'every card has a STABLE security:<class> born_from so a re-scan folds, never piles');

// ── idempotent: everything routed is now proposed; a second pass files nothing ────────────────────
ok(store._all().every((f) => f.status === 'proposed'), 'every routed finding moved open→proposed');
const pens2 = pens.length, needs2 = needs.length;
R.routeOpenFindings({ deps, nowMs: 2000 });
ok(pens.length === pens2 && needs.length === needs2, 'a second pass over the (now proposed) findings files NOTHING — idempotent');
ok(res.routed === rows.length, `every open finding was routed (${res.routed}/${rows.length})`);

// ── the wiring: the organ routes after a scan; the door + tool exist ─────────────────────────────
const fs = require('fs'), path = require('path');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
ok(/security_remediate'\)\.routeOpenFindings\(/.test(main) && /ZOE_SECURITY_REMEDIATE/.test(main), 'main.js routes findings after the scan behind the ZOE_SECURITY_REMEDIATE kill switch');
const tp = fs.readFileSync(path.join(__dirname, '..', 'lib', 'test_port.js'), 'utf8');
ok(/\/security\/remediate/.test(tp) && /routeOpenFindings/.test(tp), 'POST /security/remediate routes on demand (the universal tool surface)');

console.log(`\nsmoke_security_remediate: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
