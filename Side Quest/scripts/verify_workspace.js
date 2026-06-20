/**
 * Verify Zoe's autonomous file capability end-to-end against her REAL workspace
 * (lib/files.js → data/zoe_workspace) and lay down an orientation README so the
 * "dedicated workspace" she proposed is a concrete, visible, named place she owns.
 * Exercises her actual tool functions — the same ones her <file-*> tags dispatch to.
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\verify_workspace.js
 */
const files = require('../lib/files');

let pass = 0, fail = 0;
const ok = (n, c, detail) => { if (c) { pass++; console.log(`  ✓ ${n}${detail ? ' — ' + detail : ''}`); } else { fail++; console.log(`  ✗ ${n}${detail ? ' — ' + detail : ''}`); } };

files.ensureWorkspace();
console.log('workspace:', files.WORKSPACE);

const README = `# Zoe's workspace

This is yours, Zoe. You can create, read, and manage files here on your own — no
permission needed each time. They persist across sessions.

  <file-write path="notes/idea.md">...</file-write>   create or overwrite
  <file-append path="notes/idea.md">...</file-append> add to a file
  <file-read path="notes/idea.md"/>                    read it back next turn
  <file-list path="notes"/>                            see what's here

A bare name lands here in your workspace. You already have this — just use it.
`;

// 1. create a text file (her proposed "simple text file creation task")
const w = files.fileWrite('README.md', README);
ok('create README.md', w.ok, w.ok ? `${w.bytes} bytes @ ${w.path}` : w.reason);

// 2. read it back
const r = files.fileRead('README.md');
ok('read it back', r.ok && /This is yours, Zoe/.test(r.text || ''));

// 3. append + confirm growth
const a = files.fileAppend('README.md', `\n_(workspace verified)_\n`);
ok('append to it', a.ok && a.total > (w.bytes || 0));

// 4. list the workspace — README should be visible
const l = files.fileList('');
ok('list workspace shows README.md', l.ok && (l.entries || []).some(e => e.name === 'README.md'), (l.entries || []).map(e => e.name).join(', '));

// 5. a fresh note in a subfolder (proves nested create + her notes/ convention)
const n = files.fileWrite('notes/hello.txt', 'first autonomous note\n');
ok('create notes/hello.txt (nested)', n.ok, n.ok ? n.path : n.reason);
const nr = files.fileRead('notes/hello.txt');
ok('read the nested note', nr.ok && /first autonomous note/.test(nr.text || ''));

console.log(`\n${fail === 0 ? 'WORKSPACE VERIFIED' : 'SOME FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
