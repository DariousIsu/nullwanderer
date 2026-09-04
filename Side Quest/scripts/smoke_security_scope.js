/* smoke_security_scope.js — security self-audit, increment 1 (2026-09-04): THE BOUNDARY + THE RECORD.
 *
 * The scope module is the authorization boundary AND the injection defense: an audit tool may only ever
 * resolve to Lucas's own assets, and off-scope is a deterministic, logged refusal. The findings store is
 * the record — deduped, secrets masked. The boundary goes in before any tool; this pins it from both.
 * Scope decisions are pure; the store runs over a temp db built from the app's own DDL (read out of
 * lib/db.js so the two can never drift).
 */
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const Database = require('better-sqlite3');
const S = require('../lib/security_scope');
const F = require('../lib/security_findings');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

// ── THE BOUNDARY: paths ──────────────────────────────────────────────────────────────────────────
ok(S.pathInScope('C:\\Users\\azrae\\Desktop\\Side Quest\\main.js'), 'a file inside the SQ root is in scope');
ok(S.pathInScope('C:\\Users\\azrae\\Desktop\\NX ECHO\\nx-echo\\echo\\jobs.py'), 'a file inside the Echo root is in scope');
ok(S.pathInScope('c:/users/azrae/desktop/side quest/lib/db.js'), 'the containment test is case- and separator-insensitive (Windows)');
ok(!S.pathInScope('C:\\Users\\azrae\\Desktop\\Side QuestEvil\\x.js'), 'a sibling that only PREFIXES the root is NOT in scope (no substring false-match)');
ok(!S.pathInScope('C:\\Windows\\System32\\drivers\\etc\\hosts'), 'a system path outside every root is off-scope');
ok(!S.pathInScope('C:\\Users\\azrae\\Desktop\\NX-ALPHA\\backend\\app.py'), 'a Desktop sibling repo (NX-ALPHA) is off-scope');

// ── THE BOUNDARY: hosts / urls ─────────────────────────────────────────────────────────────────
ok(S.hostInScope('127.0.0.1') && S.hostInScope('localhost') && S.hostInScope('::1'), 'her own host loopback is in scope');
ok(S.hostInScope('127.0.0.1:8767') && S.hostInScope('http://127.0.0.1:8767/status'), 'a loopback host with a port or full url is in scope (any port on loopback is her own host)');
ok(!S.hostInScope('8.8.8.8') && !S.hostInScope('example.com') && !S.hostInScope('https://api.openai.com/v1'), 'a public host is off-scope');
ok(!S.hostInScope('localhost.evil.com') && !S.hostInScope('127.0.0.1.evil.com'), 'a host that only CONTAINS a loopback token as a label is off-scope (the injection defense)');

// ── THE GATE: refusal is deterministic and logged ─────────────────────────────────────────────
const c1 = S.check('path', 'C:\\Windows\\System32\\cmd.exe');
ok(c1.ok === false && /off-scope/.test(c1.why), 'check() returns a deterministic off-scope refusal with a reason');
ok(S.check('host', '127.0.0.1').ok === true && S.check('url', 'http://127.0.0.1:8767/roles').ok === true, 'check() passes an in-scope host and url');
let logged = null;
const g = S.gate('host', '8.8.8.8', { log: (v) => { logged = v; } });
ok(g.ok === false && logged && logged.target === '8.8.8.8', 'gate() logs an off-scope attempt (the monitor always sees it)');
ok(S.gate('path', 'C:\\Users\\azrae\\Desktop\\Side Quest\\lib\\db.js', { log: () => { logged = 'SHOULD-NOT-FIRE'; } }).ok === true && logged.target === '8.8.8.8', 'gate() does NOT log an in-scope pass');

// ── THE BOUNDARY IS READABLE (for the monitor / read door) ────────────────────────────────────
const d = S.describe();
ok(Array.isArray(d.roots) && d.roots.length === 2 && Array.isArray(d.hosts) && d.domains.length === 0, 'describe() exposes the allowlist read-only (2 roots, loopback hosts, no external domains yet)');

// ── THE RECORD: a temp db with the app's own security_findings DDL ────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq_secfind_'));
const db = new Database(path.join(dir, 'sq.db'));
const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'db.js'), 'utf8');
const ddl = dbSrc.match(/`CREATE TABLE IF NOT EXISTS security_findings \([\s\S]*?\)`/);
ok(!!ddl, 'lib/db.js declares the security_findings table');
db.exec(ddl[0].slice(1, -1));
for (const m of dbSrc.matchAll(/`(CREATE INDEX IF NOT EXISTS idx_security_findings_[\s\S]*?)`/g)) db.exec(m[1]);
const deps = { db: { getDb: () => db } };

const r1 = F.record({ asset: 'lib/keystore.js', class: 'secret', severity: 'high', title: 'hardcoded token', evidence: F.maskSecret('sk-abcd1234efgh5678'), proposed_fix: 'move to the keychain' }, { deps });
ok(r1.id && !r1.deduped, 'record() lands a finding');
const r2 = F.record({ asset: 'lib/keystore.js', class: 'secret', severity: 'critical', title: 'hardcoded token', evidence: 'x' }, { deps });
ok(r2.deduped && r2.id === r1.id, 'a re-scan of the same class+asset+title folds into the open finding (dedup)');
const r3 = F.record({ asset: 'lib/keystore.js', class: 'secret', severity: 'high', title: 'different weakness', evidence: 'y' }, { deps });
ok(r3.id !== r1.id && !r3.deduped, 'a different title is a distinct finding');

ok(F.maskSecret('sk-abcd1234efgh5678') === '<redacted:19 chars…5678>' && !/abcd/.test(F.maskSecret('sk-abcd1234efgh5678')), 'maskSecret reports length + last-4 only, never the value (the never-repeat-a-key law)');
const stored = F.get(r1.id, { deps });
ok(stored && !/abcd1234efgh/.test(stored.evidence || '') && /redacted/.test(stored.evidence || ''), 'the stored evidence for a secret is masked, not the raw value');

ok(F.record({ asset: 'x', class: 'bananas', severity: 'apocalyptic', title: 'weird one' }, { deps }).id && F.get(F.list({ deps })[0].id, { deps }).class === 'config', 'an unknown class falls to config (and an unknown severity to info)');
ok(F.record({ asset: 'x', class: 'code', title: '' }, { deps }).id === null, 'a finding with no title is refused, not stored');

ok(F.setStatus(r1.id, 'fixed', { deps }) && F.get(r1.id, { deps }).status === 'fixed', 'setStatus moves a finding to a terminal state');
ok(!F.setStatus(r1.id, 'nonsense', { deps }), 'an unknown status is refused');
const openList = F.list({ status: 'open', deps });
ok(openList.every((r) => r.status === 'open') && !openList.some((r) => r.id === r1.id), 'list(status:open) excludes the fixed finding');
const sum = F.summary({ deps });
ok(typeof sum.open === 'number' && sum.open >= 2 && sum.bySeverity && typeof sum.bySeverity === 'object', `summary() counts open findings by severity (${JSON.stringify(sum)})`);

db.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\nsmoke_security_scope: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
