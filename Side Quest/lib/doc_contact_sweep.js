/* lib/doc_contact_sweep.js — the DRIVER the doc-contacts lane never had.
 *
 * lib/doc_contacts.js built the store, the scan ledger, and the search that
 * gatherHeldContacts already consumes as its third source — and then nothing
 * ever called pendingDocs(). Measured 2026-08-01: 34 documents scanned,
 * 1,114 contacts extracted, while the parish corpus alone holds 390+ docs
 * with ~1,468 gov-domain addresses. The lane existed; no tick drove it.
 *
 * Shape mirrors lib/decompose_sweep deliberately: a few docs per tick,
 * cheapest-first, under a self-enforced daily chunk budget — a backlog
 * reader that can spend the whole corpus in one tick is a bug however
 * correct its selection is. Extraction is lib/contact_extract via the cloud
 * extraction model; the budget bounds spend structurally, so a quota-tight
 * day simply drains slower.
 */
'use strict';

const BUDGET_KEY = 'doc_contact_sweep:budget';
const DEFAULT_DAILY_CHUNKS = 200;   // ~6k chars each — bounds the cloud spend per day
const CHUNK_SIZE = 6000;

function _today(now) { return new Date(now).toISOString().slice(0, 10); }

function budgetState(db, { now = Date.now(), dailyChunks = DEFAULT_DAILY_CHUNKS } = {}) {
  let st = { day: _today(now), spent: 0 };
  try {
    const raw = db.getMeta(BUDGET_KEY);
    if (raw) { const v = JSON.parse(raw); if (v && v.day === _today(now)) st = v; }
  } catch { /* fresh day */ }
  return { ...st, limit: dailyChunks, left: Math.max(0, dailyChunks - st.spent) };
}

function spendBudget(db, chunks, { now = Date.now() } = {}) {
  const st = budgetState(db, { now });
  try { db.setMeta(BUDGET_KEY, JSON.stringify({ day: st.day, spent: st.spent + chunks })); }
  catch { /* operational marker — never fatal */ }
}

/* Scan ONE document: chunk → extract people → land rows with provenance.
 * deps: { extract(text, opts) → {people:[…]} | null } — the cloud extractor,
 * injected so smokes run without a model. Returns { found, chunks }. */
async function scanDoc(doc, { extract, docContacts, contactExtract, log = () => {} }) {
  const body = String(doc.body || '');
  const { chunks } = contactExtract.chunkForExtraction(body, { size: CHUNK_SIZE });
  let found = 0;
  const state = docContacts.stateForDoc({ ref: doc.ref, title: doc.title, body });
  for (const chunk of chunks) {
    let cards = null;
    try { cards = await extract(chunk, {}); } catch (e) { log(`extract failed: ${e.message}`); }
    for (const p of ((cards && cards.people) || [])) {
      try {
        if (docContacts.upsert(p, { docId: doc.id, docTitle: doc.title, state })) found++;
      } catch { /* one bad row never sinks the doc */ }
    }
  }
  docContacts.recordScan(doc.id, { docUpdatedTs: doc.updated_ts || null,
                                   found, chunks: chunks.length });
  return { found, chunks: chunks.length };
}

/* One sweep tick: budget check → a couple of pending docs → scan each.
 * Returns { scanned, found, chunksSpent, budget } (all zeros when quiet). */
async function runTick(db, { limit = 2, dailyChunks = DEFAULT_DAILY_CHUNKS,
                             extract, log = () => {} } = {}) {
  const docContacts = require('./doc_contacts');
  const contactExtract = require('./contact_extract');
  const out = { scanned: 0, found: 0, chunksSpent: 0, budget: null };
  const b = budgetState(db, { dailyChunks });
  out.budget = b;
  if (b.left <= 0) return out;                       // budget spent — quiet
  const docs = docContacts.pendingDocs({ limit }) || [];
  if (!docs.length) return out;                      // nothing pending — quiet
  for (const d of docs) {
    const row = db.getDocument(d.id);
    if (!row || !String(row.body || '').trim()) {
      // an empty doc still gets its ledger row — absence must not re-queue forever
      docContacts.recordScan(d.id, { docUpdatedTs: d.updated_ts || null, found: 0, chunks: 0 });
      continue;
    }
    const r = await scanDoc({ ...row, updated_ts: d.updated_ts }, { extract, docContacts, contactExtract, log });
    out.scanned++;
    out.found += r.found;
    out.chunksSpent += r.chunks;
    if (out.chunksSpent >= b.left) break;            // never overshoot the day
  }
  if (out.chunksSpent) spendBudget(db, out.chunksSpent);
  return out;
}

module.exports = { runTick, scanDoc, budgetState, spendBudget,
                   DEFAULT_DAILY_CHUNKS, CHUNK_SIZE, BUDGET_KEY };
