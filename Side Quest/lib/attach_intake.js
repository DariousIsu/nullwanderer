'use strict';
/**
 * lib/attach_intake.js — THE ATTACHMENT LAND DOOR (2026-08-14, the fabricated-review audit).
 *
 * Measured live: Lucas attached "The Community Benefits of Data Centers.docx"; the renderer read
 * the ZIP bytes as UTF-8 (f.text()), main capped the mojibake at 6,000 chars, nothing landed in
 * any store — and the reply (#11891) said "I've read through the document… The JobsOhio case
 * study gives it grounding" (JobsOhio exists nowhere in her stores: confabulated end to end).
 *
 * The cure, per attachment:
 *   1) A file-backed attachment whose renderer text is binary/empty is EXTRACTED through the same
 *      organ as canvas drops (doc_extract via injected extractFile).
 *   2) Readable text is LANDED through doc_store (injected landDoc) — coordinate + hash-dedup +
 *      importance; the prompt carries an excerpt, the store carries the whole document
 *      ([[full-document-ingest]]).
 *   3) A file that still cannot be read SAYS SO in the composed message — the model is told
 *      plainly not to claim a reading, so the reply is "it didn't open", never a review of vapor.
 *
 * Pure composition over injected doors; no direct fs/db so the gate tests every branch.
 */

const EXCERPT_CAP = 6000;   // prompt-side excerpt budget (unchanged from the old cap; the FULL text lives in the store)
const MIN_READABLE = 40;    // below this the "text" is not a document

/** Binary sniff on renderer-supplied text: ZIP magic, or >5% control/replacement chars in the head. */
function looksBinary(s) {
  const probe = String(s || '').slice(0, 2000);
  if (!probe) return false;
  if (probe.startsWith('PK')) return true;   // zip container (docx/xlsx/pptx)
  let bad = 0;
  for (const ch of probe) {
    const x = ch.codePointAt(0);
    if (x === 0xFFFD || (x < 32 && x !== 9 && x !== 10 && x !== 13)) bad++;
  }
  return bad / probe.length > 0.05;
}

/**
 * composeAttachmentBlock(attachment, deps) → prompt block string for ONE non-image attachment.
 * deps: { userName, extractFile(path)→{text,via}|null (async), landDoc({title,body,ref})→{id}|null, log }
 */
async function composeAttachmentBlock(a, { userName = 'Lucas', extractFile = null, landDoc = null, log = () => {} } = {}) {
  if (!a || a.image) return '';
  const name = a.name || 'file';
  let text = String(a.text || '');
  let via = 'renderer-text';
  if (a.path && extractFile && (looksBinary(text) || text.trim().length < MIN_READABLE)) {
    try {
      const r = await extractFile(a.path);
      if (r && r.text && String(r.text).trim().length >= MIN_READABLE) { text = String(r.text); via = r.via || 'doc_extract'; }
    } catch (e) { log(`[attach] extract failed for "${name}": ${e.message}`); }
  }
  if (looksBinary(text) || text.trim().length < MIN_READABLE) {
    log(`[attach] "${name}" UNREADABLE (${text.length}ch via ${via}) — honesty seam engaged`);
    return `${userName} attached "${name}" but the file COULD NOT BE READ (binary or unsupported format${a.path ? '' : '; the renderer sent no file path'}). You have NOT seen its contents. Do not claim to have read or reviewed it — tell ${userName} plainly that it didn't open, and ask for the file again or a readable copy (.md/.txt/.pdf/.docx re-attached).`;
  }
  let coord = '';
  if (landDoc) {
    try {
      const doc = landDoc({ title: `Attached: ${name}`.slice(0, 140), body: text, ref: a.path || 'chat-attachment' });
      if (doc && doc.id) { coord = ` It is INGESTED as doc#${doc.id} — the FULL text is readable via your localdb/doc tools.`; log(`[attach] "${name}" landed as doc#${doc.id} via ${via} (${text.length}ch)`); }
    } catch (e) { log(`[attach] land failed for "${name}": ${e.message}`); }
  }
  return `${userName} attached "${name}" (${text.length} chars, read via ${via}).${coord}\nOpening excerpt:\n${text.slice(0, EXCERPT_CAP)}`;
}

module.exports = { composeAttachmentBlock, looksBinary, EXCERPT_CAP, MIN_READABLE };
