/*
 * lib/product_ledger.js — retrieval-first recall of HER OWN PRODUCTS. PURE + offline-testable core.
 *
 * Why this exists (2026-08-07, the Louisiana list): "Can you pull up that most recent list of ten
 * people in Louisiana that we found contact information for?" (#11102) — the product EXISTED
 * (inquiry #201's docs, made the previous afternoon) and she regenerated instead: a fresh CRM
 * aggregate, a different list, plus an offer to research 101,475 contacts. Same class as the
 * Hartfield report miss: every prior fix was a phrasing net over one hole — nothing at reply time
 * treats "that thing we made" as an EPISODIC ARTIFACT reference. Semantic recall (active_recall)
 * searches facts about the world; "that list we made" is a fact about OUR WORK, resolvable only by
 * a time-ordered product lookup. (Outside grounding: arXiv 2605.12087 — intermediate artifacts as
 * first-class citizens with lineage; regeneration must be an explicit decision, never a default.)
 *
 * v1 is a FEDERATED READ over the stores products already land in (documents table + notes/*.md) —
 * deliberately NO new table and NO writers, so there is no dual-write drift (the two-sources-of-
 * truth disease). The registry IS a query. Consumers:
 *   - the pull-up gate (main.js, before the report-command net): detectAsk → searchProducts →
 *     present the ACTUAL artifact; on a miss it falls through so compose/operator can build fresh.
 *
 * Deliberately STRICT detect: a retrieve verb + a product noun + an EPISODIC anchor (that/my/the
 * latest/…we made). "Make me a list" (build), "pull up the CRM record" (data, not a product), and
 * "what does the report say" (asking about content) must NOT fire.
 */
'use strict';

const str = (v) => (v == null ? '' : String(v));

// Product nouns — artifact shapes she produces.
const NOUN = 'list|report|brief(?:ing)?|dossier|documents?|docs?|files?|notes?|tables?|spreadsheets?|summary|memo|write-?ups?|papers?|deliverables?|profiles?|rosters?';
// Retrieve verbs — hand me the existing thing.
const RETRIEVE = /\b(pull (?:up|out)|bring up|show (?:me )?|open (?:up )?|display|where(?:'s| is| are)|find (?:me )?|get (?:me )?|give me|can (?:i|you) (?:have|get|see|pull up|show|open)|resend|send (?:me )?(?:that|the)|look at)\b/i;
// Build imperatives — if the message LEADS with one, it's a build order, not a retrieval.
const LEADS_BUILD = /^\s*(?:please\s+)?(?:now\s+)?(?:can you\s+|could you\s+|would you\s+)?(?:make|build|create|write|draft|generate|compose|produce|prepare|assemble)\b/i;
// Asking ABOUT a product's content, not for the product.
const ABOUT = /\b(what (?:does|do|did|is|are)|why (?:does|did)|how (?:does|did)|summarize|explain)\b/i;

// The EPISODIC anchor — the signal that a specific prior product is meant:
//   "that/this/my/our <noun>", "the (most) recent/latest/last <noun>", or a shared-history clause
//   ("…we found/made/built/researched/compiled/put together/worked on/did/wrote").
function _hasAnchor(t) {
  const nounRe = `(?:${NOUN})`;
  if (new RegExp(`\\b(?:that|this|my|our)\\b[^.?!]{0,40}\\b${nounRe}\\b`, 'i').test(t)) return true;
  if (new RegExp(`\\b(?:most recent|recent|latest|last)\\b[^.?!]{0,30}\\b${nounRe}\\b`, 'i').test(t)) return true;
  if (/\b(?:we|you)\s+(?:found|made|built|created|researched|compiled|wrote|drafted|generated|put together|worked on|did|produced|assembled)\b/i.test(t)) return true;
  if (/\bagain\b/i.test(t)) return true;
  return false;
}

/**
 * detectAsk(text) → { subject } when the message asks to RETRIEVE a prior product, else null.
 * subject = the noun phrase to search the product stores with (product noun + its qualifiers,
 * with the shared-history clause words kept — they often carry the real keywords, e.g. "…that we
 * found CONTACT INFORMATION for").
 */
function detectAsk(text) {
  const t = str(text).trim();
  if (!t) return null;                        // no length cap — a detailed ask is still an ask
  const nounRe = new RegExp(`\\b(?:${NOUN})\\b`, 'i');
  if (!nounRe.test(t)) return null;
  if (LEADS_BUILD.test(t)) return null;
  if (ABOUT.test(t)) return null;
  if (!RETRIEVE.test(t)) return null;
  if (!_hasAnchor(t)) return null;
  // Subject: from the product noun to the end of the clause, minus grammar noise.
  const m = t.match(new RegExp(`\\b(${NOUN})\\b\\s*(.*)$`, 'i'));
  const noun = m ? m[1] : '';
  let tail = m ? m[2] : '';
  tail = tail
    .replace(/[?.!]+\s*$/g, '')
    .replace(/\b(?:that|which|who)\s+(?:we|you)\s+(?:found|made|built|created|researched|compiled|wrote|drafted|generated|put together|worked on|did|produced|assembled)\b/gi, ' ')
    .replace(/\b(?:please|for me|thanks|thank you|again|of|for|on|about|with|the|a|an)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const subject = `${noun} ${tail}`.replace(/\s+/g, ' ').trim();
  if (subject.length < 4) return null;
  return { subject };
}

// Significant search tokens from a subject phrase.
function tokensOf(subject) {
  const STOP = new Set(['list', 'report', 'brief', 'briefing', 'dossier', 'document', 'documents', 'doc', 'docs', 'file', 'files', 'note', 'notes', 'table', 'tables', 'spreadsheet', 'spreadsheets', 'summary', 'memo', 'paper', 'papers', 'deliverable', 'deliverables', 'profile', 'profiles', 'roster', 'rosters', 'write-up', 'writeup', 'people', 'person', 'info', 'information', 'most', 'recent', 'latest', 'last', 'ten', 'top']);
  const raw = str(subject).toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) || [];
  const out = [];
  for (const w of raw) if (!STOP.has(w) && !out.includes(w)) out.push(w);
  // Numbers matter for lists ("ten people", "top 10") — keep digits as weak tokens.
  for (const n of (str(subject).match(/\b\d{1,4}\b/g) || [])) if (!out.includes(n)) out.push(n);
  return out.slice(0, 8);
}

/**
 * searchProducts({ db, query, notesDir?, limit?, now? }) → ranked hits over the product stores:
 *   documents table (non-news, non-conversation, non-web_page — ingested pages are her READING,
 *   not products she made; the surfaces inquiry/autonomy/research products land in) and
 *   notes/*.md files. Score = token matches (title heavily, body lightly) with a
 *   recency decay — "that recent list" should prefer yesterday's product over last month's.
 * Hit: { kind:'doc'|'note', id?, path?, title, ts, score, label }.
 */
function searchProducts({ db, query, notesDir = null, limit = 3, now = Date.now() } = {}) {
  const toks = tokensOf(query);
  if (!toks.length) return [];
  const hits = [];
  const decay = (ts) => { const days = Math.max(0, (now - (ts || 0)) / 86400000); return Math.max(0.25, 1.4 - 0.15 * days); };
  try {
    const like = toks.map(() => `(title LIKE ? OR body LIKE ?)`).join(' OR ');
    const params = []; for (const w of toks) { params.push(`%${w}%`, `%${w}%`); }
    const rows = db.getDb().prepare(
      `SELECT id, title, source, created_ts, substr(COALESCE(body,''),1,4000) body FROM documents
       WHERE COALESCE(source,'') NOT IN ('news', 'web_page')
         AND COALESCE(title,'') NOT LIKE 'Conversation —%'
         AND created_ts > ?
         AND (${like})
       ORDER BY created_ts DESC LIMIT 200`
    ).all(now - 45 * 86400000, ...params);
    for (const r of rows) {
      const title = str(r.title).toLowerCase(), body = str(r.body).toLowerCase();
      let score = 0;
      for (const w of toks) { if (title.includes(w)) score += 3; else if (body.includes(w)) score += 1; }
      if (score <= 2) continue;                                    // one weak body token is not a match
      score *= decay(r.created_ts);
      hits.push({ kind: 'doc', id: r.id, title: str(r.title).slice(0, 140), ts: r.created_ts, score, label: `doc#${r.id} [${r.source}] ${str(r.title).slice(0, 80)}` });
    }
  } catch { /* store read is fail-soft */ }
  try {
    if (notesDir) {
      const fs = require('fs'); const path = require('path');
      const files = fs.readdirSync(notesDir).filter((f) => /\.md$/i.test(f)).slice(-400);
      for (const f of files) {
        const p = path.join(notesDir, f);
        let st = null; try { st = fs.statSync(p); } catch { continue; }
        if (now - st.mtimeMs > 45 * 86400000) continue;
        let head = ''; try { head = fs.readFileSync(p, 'utf8').slice(0, 2000); } catch {}
        const hay = `${f} ${head}`.toLowerCase();
        let score = 0; for (const w of toks) if (hay.includes(w)) score += (f.toLowerCase().includes(w) ? 3 : 1);
        if (score <= 2) continue;
        score *= decay(st.mtimeMs);
        hits.push({ kind: 'note', path: `notes/${f}`, title: f, ts: st.mtimeMs, score, label: `notes/${f}` });
      }
    }
  } catch { /* notes read is fail-soft */ }
  hits.sort((a, b) => b.score - a.score || b.ts - a.ts);
  return hits.slice(0, Math.max(1, limit));
}

module.exports = { detectAsk, searchProducts, tokensOf };
