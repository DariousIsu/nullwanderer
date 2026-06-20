/**
 * Smoke test for the permissions table + injection (lib/permissions.js, db.js).
 * Verifies seeding, status reads, the high-primacy block content, that grant/deny
 * persist, and that re-seeding never clobbers a status Lucas changed.
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\smoke_permissions.js
 */
const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_permtest_${Date.now()}`, 'sq.db');

const D = require('../lib/db'); D.init();
const perms = require('../lib/permissions');

let pass = 0, fail = 0;
const ok = (n, c, detail) => { if (c) { pass++; console.log(`  ✓ ${n}${detail ? ' — ' + detail : ''}`); } else { fail++; console.log(`  ✗ ${n}${detail ? ' — ' + detail : ''}`); } };

console.log('Seeding + reads:');
const rows = perms.list();
ok('seeds all defaults', rows.length === perms.DEFAULTS.length, `${rows.length} rows`);
ok('files_workspace granted', perms.status('files_workspace') === 'granted');
ok('send_email is granted_with_judgment', perms.status('send_email') === 'granted_with_judgment');
ok('unknown capability → null', perms.status('nope_not_real') === null);

console.log('\nInjection block:');
const block = perms.buildPromptBlock();
ok('has the "already have" header', /CAPABILITIES YOU ALREADY HAVE/.test(block));
ok('tells her not to ask / not to propose establishing', /do not ask permission/i.test(block) && /establish/i.test(block));
ok('lists files_workspace + how', /files_workspace/.test(block) && /file-write/.test(block));
ok('has the judgment section for send_email', /judgment/i.test(block) && /send_email/.test(block));

console.log('\nGrant/deny persist + re-seed safety:');
perms.deny('observe_screen');
ok('deny took effect', perms.status('observe_screen') === 'denied');
ok('denied shows in NOT-permitted section', /NOT permitted/i.test(perms.buildPromptBlock()) && /observe_screen/.test(perms.buildPromptBlock()));
D.seedPermission({ capability: 'observe_screen', status: 'granted', description: 'x' });  // re-seed attempt
ok('re-seed does NOT clobber a changed status', perms.status('observe_screen') === 'denied');
perms.grant('observe_screen');
ok('grant restores it', perms.status('observe_screen') === 'granted');

console.log(`\n${fail === 0 ? 'ALL PERMISSIONS TESTS OK' : 'SOME FAILURES'} — ${pass} passed, ${fail} failed`);
try { D.getDb().close(); } catch {}
process.exit(fail === 0 ? 0 : 1);
