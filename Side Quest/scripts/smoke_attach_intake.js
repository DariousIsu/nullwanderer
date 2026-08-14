/**
 * THE ATTACHMENT LAND DOOR (2026-08-14, the fabricated-review audit): a .docx attachment arrived
 * as ZIP mojibake, landed nowhere, and the reply reviewed it anyway ("JobsOhio case study",
 * #11891 — exists in no store). Pins: binary sniff, extraction through the injected organ, LAND
 * with coordinate, the honesty seam for unreadable files (never a review of vapor), excerpt cap.
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\smoke_attach_intake.js
 */
const ai = require('../lib/attach_intake');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

(async () => {
  // The binary sniff.
  ok('ZIP magic (docx/xlsx) reads as binary', ai.looksBinary('PK\u0003\u0004\u0014zzzz'));
  ok('control-character soup reads as binary', ai.looksBinary('\u0000\u0001\u0002abc\u0005\u0007def\u0000\u0001\u0002\u0003'));
  ok('normal prose does not', !ai.looksBinary('The community benefits of data centers are best understood through workforce data.'));

  const landCalls = [];
  const landDoc = ({ title, body, ref }) => { landCalls.push({ title, len: body.length, ref }); return { id: 4242 }; };

  // 1) Readable text attachment → excerpt + LANDED coordinate.
  const prose = 'A '.repeat(30) + 'genuine readable research document about data centers and community benefit agreements.';
  const b1 = await ai.composeAttachmentBlock({ name: 'paper.md', text: prose }, { userName: 'Lucas', landDoc });
  ok('readable attachment lands with a doc# coordinate', b1.includes('doc#4242') && b1.includes('Opening excerpt') && landCalls.length === 1 && landCalls[0].title === 'Attached: paper.md');

  // 2) Binary renderer-text + path + working extractor → extracted, landed, via named.
  const extractFile = async (p) => ({ text: 'Extracted document body. '.repeat(20), via: 'doc_extract:docx' });
  const b2 = await ai.composeAttachmentBlock({ name: 'paper.docx', text: 'PK\u0003\u0004garbage', path: 'C:/x/paper.docx' },
    { userName: 'Lucas', extractFile, landDoc });
  ok('binary docx extracts through the organ and lands', b2.includes('read via doc_extract:docx') && b2.includes('doc#4242') && b2.includes('Extracted document body'));

  // 3) Binary + path + DEAD extractor → the honesty seam, never a fake excerpt.
  const b3 = await ai.composeAttachmentBlock({ name: 'paper.docx', text: 'PK\u0003\u0004garbage', path: 'C:/x/paper.docx' },
    { userName: 'Lucas', extractFile: async () => ({ text: '', via: 'missing' }), landDoc });
  ok('unreadable file → honesty seam ("COULD NOT BE READ", no reading claim allowed)',
    b3.includes('COULD NOT BE READ') && /Do not claim to have read/i.test(b3) && !b3.includes('Opening excerpt'));

  // 4) Binary with NO path (old renderer payload) → honesty seam names the missing path.
  const b4 = await ai.composeAttachmentBlock({ name: 'paper.docx', text: 'PK\u0003\u0004garbage' }, { userName: 'Lucas', landDoc });
  ok('no-path binary → honesty seam (renderer sent no file path)', b4.includes('COULD NOT BE READ') && b4.includes('no file path'));

  // 5) Images skip (they ride the vision path), and a dead land door still returns the block.
  ok('image attachments skip this door', (await ai.composeAttachmentBlock({ name: 'x.png', image: true, text: 'zz' }, {})) === '');
  const b6 = await ai.composeAttachmentBlock({ name: 'paper.md', text: prose }, { userName: 'Lucas', landDoc: () => { throw new Error('db down'); } });
  ok('a dead land door is fail-soft — excerpt still reaches the turn', b6.includes('Opening excerpt') && !b6.includes('doc#'));

  // 6) The excerpt cap holds; the store got the WHOLE text.
  const big = 'Community benefit fact. '.repeat(1000);   // ~24k chars
  const b7 = await ai.composeAttachmentBlock({ name: 'big.md', text: big }, { userName: 'Lucas', landDoc });
  ok('prompt excerpt capped, store receives the full text', b7.length < ai.EXCERPT_CAP + 400 && landCalls[landCalls.length - 1].len === big.length);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
