/**
 * Offline smoke for the in-house citation ATTACHMENT flow:
 *   editor_registry citation_attachments CRUD  +  verify_resolve rung-0 (attached citation resolves
 *   from the operator's document, tier 'reference', and NEVER calls the web).
 * Run: ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/smoke_editor_attach.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP_DB = path.join(os.tmpdir(), `editor_attach_${Date.now()}.db`);
process.env.EDITOR_DB_PATH = TMP_DB;
const Reg = require('../lib/editor_registry');
const R = require('../studio/verify_resolve');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } }

(async () => {
  try {
    Reg.init({ path: TMP_DB });

    // ---- registry: attachment CRUD, keyed by (doc, version, citation uid) ----
    const doc = Reg.registerDocument({ title: 'Brief under review', source: 'upload' });
    const saved = Reg.saveAttachment(doc.id, 1, 'a0.s0', { title: 'In-house report', docRef: 'C:/x/report.pdf', text: 'body text long enough to store' });
    ok('saveAttachment returns the row', saved && saved.uid === 'a0.s0' && saved.title === 'In-house report');

    const map = Reg.getAttachmentMap(doc.id, 1);
    ok('getAttachmentMap keys by uid → {title,text}', map['a0.s0'] && map['a0.s0'].title === 'In-house report' && /body text/.test(map['a0.s0'].text));

    Reg.saveAttachment(doc.id, 1, 'a0.s0', { title: 'In-house report v2', docRef: 'C:/x/report2.pdf', text: 'revised body text content' });
    ok('saveAttachment upserts per (doc,version,uid) — no dup', Reg.listAttachments(doc.id, 1).length === 1 && Reg.getAttachment(doc.id, 1, 'a0.s0').title === 'In-house report v2');

    Reg.saveAttachment(doc.id, 1, 'a3.s1', { title: 'Second source', docRef: 'C:/x/two.docx', text: 'another in-house passage of text' });
    ok('a second citation can carry its own attachment', Reg.listAttachments(doc.id, 1).length === 2);

    Reg.deleteAttachment(doc.id, 1, 'a0.s0');
    ok('deleteAttachment removes just that one', Reg.getAttachment(doc.id, 1, 'a0.s0') === null && Reg.listAttachments(doc.id, 1).length === 1);

    // ---- verify_resolve rung 0: attached citation resolves from the doc, no web call ----
    let webCalls = 0;
    const callTool = async () => { webCalls++; return { text: JSON.stringify({ status: 200, text_preview: 'x'.repeat(120) }) }; };
    const attachments = { 'a0.s0': { title: 'In-house report', text: 'The claim is directly supported by this in-house passage of prose. '.repeat(2) } };

    const r0 = await R.resolveUnit({ uid: 'a0.s0', text: 'a claim', url: 'https://example.com/x' }, callTool, { attachments });
    ok('attached citation resolves (tier reference)', r0.resolved && r0.tier === 'reference', `${r0.tier}`);
    ok('resolved source_text IS the attached doc', /in-house passage/.test(r0.source_text));
    ok('source_url = attached doc title', r0.source_url === 'In-house report', `${r0.source_url}`);
    ok('NO web tool called for an attached citation', webCalls === 0, `webCalls=${webCalls}`);
    ok('trail records the attached rung', Array.isArray(r0.trail) && r0.trail.some(t => t.step === 'attached'));

    // ---- a citation WITHOUT an attachment falls through to the normal web ladder ----
    webCalls = 0;
    const r1 = await R.resolveUnit({ uid: 'a9.s9', text: 'other claim', url: 'https://example.com/y' }, callTool, { attachments });
    ok('unattached citation uses the web ladder', r1.resolved && r1.tier === 'fetch' && webCalls >= 1, `tier=${r1.tier} webCalls=${webCalls}`);

    // ---- too-thin attachment is ignored (falls through, not a false resolve) ----
    webCalls = 0;
    const thin = { 'a0.s0': { title: 'tiny', text: 'too short' } };
    const r2 = await R.resolveUnit({ uid: 'a0.s0', text: 'claim', url: 'https://example.com/z' }, callTool, { attachments: thin });
    ok('thin attachment ignored → web ladder used', r2.tier === 'fetch' && webCalls >= 1, `tier=${r2.tier}`);

  } catch (e) {
    fail++; console.log('  FAIL (threw) —', e.message); console.error(e);
  } finally {
    Reg.close();
    for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.unlinkSync(f); } catch {} }
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
