/**
 * lib/held_roster.js — chat-path homecoming. A "list / roster of X officials/contacts" request must be
 * answered from a HELD roster she already holds, not from an empty Puller/CRM contacts store. Measured
 * failure (boot79): Lucas asked for the Louisiana parish contact list; she held doc #8443 (all 64
 * parishes, 6,694 rows) and told him "the list is currently empty—no contacts have been entered yet,"
 * then built an empty-placeholder Canvas. The contacts store reads only Puller+CRM (both empty for
 * parishes); it never sees the roster doc that IS the answer.
 *
 * recognize() closes that gap: for a list/roster request, find a held documents-table whose TITLE
 * carries the request's topic and whose BODY extracts as an officials roster (via table_extract), and
 * return the extracted answer as a knowledge block. Content match + body verification — a title match
 * alone never answers, so "list my meetings" won't wrongly surface a roster. Pure-ish + fail-soft
 * (returns null on any miss/error); the only IO is a bounded read of her own documents.
 */
'use strict';
const str = (v) => (v == null ? '' : String(v));
function _db(deps) { return (deps && deps.db) || require('./db'); }

// Is this a request for a LIST/ROSTER of people/officials/contacts (vs a plain question)?
const LIST_RE = /\b(list|roster|directory|contacts?|officials?|leaders?|representatives?|members?|who (?:are|is|leads?|runs?)|all (?:the|of the)|every)\b/i;
const _STOP = new Set(['list', 'roster', 'directory', 'the', 'and', 'for', 'our', 'your', 'all', 'every', 'who', 'are', 'with', 'show', 'give', 'get', 'current', 'currently', 'please', 'contacts', 'contact', 'officials', 'official', 'leaders', 'leader', 'members', 'member', 'coming', 'that', 'this', 'have', 'held', 'about', 'from', 'they', 'them', 'what', 'when', 'where', 'how', 'many', 'much', 'like', 'want', 'need', 'people']);

// Distinctive topic nouns in the request (≥4 chars, minus filler) — the tokens a held roster's TITLE
// would carry (e.g. "parish" from "the LA parish contacts").
function _topicTokens(text) {
  return [...new Set((str(text).toLowerCase().match(/[a-z]{4,}/g) || []).filter((w) => !_STOP.has(w)))].slice(0, 8);
}

// Find a held roster that IS the requested list and return its extracted answer as a knowledge block.
function recognize(text, { deps = {} } = {}) {
  const q = str(text);
  if (!LIST_RE.test(q)) return null;
  const topics = _topicTokens(q);
  if (!topics.length) return null;
  let rows = [];
  try {
    const d = _db(deps).getDb();
    const like = topics.map(() => 'LOWER(title) LIKE ?').join(' OR ');
    rows = d.prepare(`SELECT id, title, body FROM documents WHERE ${like} ORDER BY id DESC LIMIT 8`)
      .all(...topics.map((t) => `%${t}%`));
  } catch { return null; }
  const T = require('./table_extract');
  for (const r of rows) {
    const ans = T.officialsAnswer(str(r.body), { cite: `doc #${r.id}` });
    if (ans && ans.text) {
      const block = [
        `YOU ALREADY HOLD THIS LIST — it is doc #${r.id} ("${str(r.title)}") in your own store, and it is extracted below (${ans.groups} ${str(ans.groupCol).toLowerCase()}s). Present THIS as the answer and cite doc #${r.id}. Do NOT say the list is empty, and do NOT start a new empty document — you already have it.`,
        ans.text,
      ].join('\n');
      return { docId: r.id, title: r.title, groups: ans.groups, groupCol: ans.groupCol, text: ans.text, block };
    }
  }
  return null;
}

module.exports = { recognize, _topicTokens, LIST_RE };
