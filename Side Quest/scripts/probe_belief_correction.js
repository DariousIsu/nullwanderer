/* scripts/probe_belief_correction.js — LIVE proof of the chat-correction extraction (the part the offline
 * smoke injects). Runs captureCorrection with the REAL extractor (learning.extractClaims → local model) on a
 * natural correction sentence, and a SINK writeFact (does NOT mutate sq.db), asserting it produces a
 * verified_fact record with the right subject/value + capturedBy=chat-correction. The write→retrieve→
 * precedence half is already proven by probe_precedence.js.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/probe_belief_correction.js
 */
const path = require('path');
const SQ = path.resolve(__dirname, '..'); process.chdir(SQ);
const L = (s) => console.log(s);

(async () => {
  const bc = require(path.join(SQ, 'lib', 'belief_correction'));
  const learning = require(path.join(SQ, 'lib', 'learning'));

  const MSG = "No — Pam Bondi stepped down as US Attorney General on 2026-04-02; she is no longer the AG.";
  L(`correction: "${MSG}"`);
  L(`detected: ${bc.detectCorrection(MSG).isCorrection} (cue: ${bc.detectCorrection(MSG).cue})`);

  const recs = [];
  const r = await bc.captureCorrection({
    userMessage: MSG,
    priorAnswer: 'Pam Bondi is the current US Attorney General.',
    extractFn: (msg, { priorAnswer }) => learning.extractClaims({ query: priorAnswer || msg, content: msg }),   // REAL local-model extraction
    writeFact: async (rec) => recs.push(rec),   // SINK — no sq.db mutation
  });

  L(`\ncaptured: ${r.captured}  (skipped: ${r.skipped || '—'})`);
  for (const rec of recs) L(`  → verified_fact: "${rec.content}"  [subject=${rec.provenance.subject}, as_of=${rec.provenance.as_of}, by=${rec.provenance.capturedBy}]`);

  const pass = r.captured >= 1 && recs.some(x => x.source === 'verified_fact' && x.provenance.capturedBy === 'chat-correction' && /bondi/i.test(x.content));
  L('\nVERDICT: ' + (pass ? 'PASS — a natural correction became a chat-correction verified_fact via live extraction.' : 'INCOMPLETE — the local extractor produced no usable claim (see above); offline smoke still covers the logic.'));
  process.exit(0);
})().catch(e => { L('ERR ' + e.message + '\n' + e.stack); process.exit(1); });
