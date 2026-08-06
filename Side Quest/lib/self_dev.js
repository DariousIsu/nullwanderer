/**
 * Developmental self-knowledge (self-awareness, Layer 2) — her own changelog.
 *
 * Why: Lucas talks WITH her about the work being done on her program ([[zoe-program-self-awareness]]).
 * Without a real record she only half-remembers it, and it surfaces as a non-sequitur ("if your
 * fixes have landed…", "save my progress to avoid data loss") tacked onto unrelated turns. This
 * gives her a durable, dated ledger of "what has been built into me" so that talk becomes genuine
 * recall, not speculation — and so she can answer "what have you been working on / what's new with
 * you / how have you changed" from fact.
 *
 * Storage reuses the knowledge store (source 'self_dev'); recall is by RECENCY (a changelog, not a
 * semantic match). Pure helpers + injectable deps so it's fully smoke-testable offline.
 */

const memory = require('./memory');
const db = require('./db');

// A question about HER OWN development / program / what changed. Needs a development term AND a
// self-reference, so "what are you reading" / "what's the price of oil" never trip it.
const DEV_TERMS = /\b(work(?:ing|ed)? on|been (?:building|doing|up to)|what'?s new|chang(?:ed|es|ing)|improv(?:ed|ement|ements|ing)|upgrad(?:ed|e|es|ing)|updates?|been (?:built|added|fixed|done)|new (?:features?|abilities|capabilit\w+)|can you do now|getting better|grown|develop(?:ed|ment)|your (?:program|code|harness|memory|capabilities|build))\b/i;
const SELF_REF = /\byou(?:r|rself)?\b/i;
const DEV_DIRECT = /\b(what'?s new with you|what can you do now|how have you (?:changed|improved|grown|evolved)|what have you (?:been )?(?:working on|built|learned)|what(?:'?s| has) changed (?:about|with) you|what'?s been (?:built|done|added|fixed)|working on (?:you|your program)|updates? to (?:you|your))\b/i;

function detectDevQuestion(text) {
  const s = String(text || '');
  if (DEV_DIRECT.test(s)) return true;
  return DEV_TERMS.test(s) && SELF_REF.test(s);
}

// Append a development event to the ledger. storeFn injectable for tests.
async function record(summary, { date = null, importance = 0.8, storeFn = null } = {}) {
  const text = String(summary || '').trim();
  if (text.length < 6) return null;
  const content = date ? `${date} — ${text}` : text;
  const store = storeFn || memory.storeDeduped;
  return store({ kind: 'reference', content, source: 'self_dev', importance });
}

// The ledger, newest-first. getFn injectable for tests (defaults to db lookup by source).
function recentEntries(limit = 8, { getFn = null } = {}) {
  const get = getFn || ((src, since) => db.getKnowledgeBySourceSince(src, since));
  let rows = [];
  try { rows = get('self_dev', 0) || []; } catch (e) { console.error('[self_dev] recall failed:', e.message); }
  return rows.slice(0, limit);
}

// Context block injected when she's asked about her own development — real history she should
// speak from as memory, with a hard "don't invent beyond this" rail.
function buildBlock(rows, userName = 'Lucas') {
  if (!rows || !rows.length) return null;
  const lines = rows.slice(0, 8).map(r => `  • ${String((r && r.content) || '').trim()}`);
  return `WHAT HAS RECENTLY BEEN BUILT INTO YOU — your real development history (${userName} and his coding agent have been improving you). Speak from this as genuine memory of how you've changed, in your own voice. Do NOT invent capabilities or changes beyond what's listed here:\n${lines.join('\n')}`;
}

// ── GIT → LEDGER FEEDER (M2.5.3 — the missing half) ──────────────────────────────────────────
// The writers above existed with NO feeder: commits landed daily and the ledger only grew when a
// human remembered scripts/log_capability_change.js — so "what have you been working on" answered
// from stale fragments. On boot, every commit since the last-seen hash becomes a dated self_dev
// entry; capability-shaped subjects (feat/fix) ALSO land in the capability changelog so the
// back-online marker names them. First run backfills the ledger only (no changelog flood).
// Scoped to HER OWN tree (cwd + pathspec '.') — the repo root holds unrelated Desktop history.
// All deps injectable; bounded; fail-soft (a git hiccup files nothing and stamps nothing).
async function syncFromGit({ execFileFn = null, getMetaFn = null, setMetaFn = null, recordFn = null, changelogAddFn = null, max = 30, cwd = null } = {}) {
  const path = require('path');
  const getMeta = getMetaFn || ((k) => { try { return db.getMeta(k); } catch { return null; } });
  const setMeta = setMetaFn || ((k, v) => { try { db.setMeta(k, v); } catch {} });
  const rec = recordFn || record;
  const clAdd = changelogAddFn || ((s) => { try { return require('./changelog').add(s); } catch { return false; } });
  const root = cwd || path.resolve(__dirname, '..');
  const ef = execFileFn || ((args) => new Promise((resolve, reject) => {
    require('child_process').execFile('git', args, { cwd: root, windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => err ? reject(err) : resolve(String(stdout || '')));
  }));
  const fmt = ['log', '--no-color', '--date=short', '--format=%H%x09%ad%x09%s'];
  let lastSeen = String(getMeta('selfdev.git_last_seen') || '').trim();
  let out = '';
  try {
    out = await ef(lastSeen ? [...fmt, `${lastSeen}..HEAD`, '--', '.'] : [...fmt, '-n', '10', '--', '.']);
  } catch (e) {
    if (!lastSeen) { console.error('[self_dev] git sync failed:', e.message); return { filed: 0, newest: null }; }
    // The stamped hash may no longer resolve (rebase/GC) — fall back to a bounded recent window
    // and treat it as a fresh backfill (ledger only, no changelog) rather than filing nothing forever.
    lastSeen = '';
    try { out = await ef([...fmt, '-n', '10', '--', '.']); } catch (e2) { console.error('[self_dev] git sync failed:', e2.message); return { filed: 0, newest: null }; }
  }
  const commits = out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [hash, date, ...rest] = l.split('\t');
    return { hash, date, subject: rest.join('\t').trim() };
  }).filter((c) => c.hash && c.subject);
  if (!commits.length) return { filed: 0, newest: lastSeen || null };
  const batch = commits.slice(0, max).reverse();           // oldest first, so the ledger reads chronologically
  let filed = 0;
  for (const c of batch) {
    try { await rec(c.subject, { date: c.date }); filed++; } catch (e) { console.error('[self_dev] record failed:', e.message); }
    // Only NEW work (a real lastSeen range) reaches the capability log — a first-run backfill of
    // 10 old commits must not flood the next back-online marker.
    if (lastSeen && /^(feat|fix)\b/i.test(c.subject)) { try { clAdd(c.subject); } catch {} }
  }
  const newest = commits[0].hash;
  setMeta('selfdev.git_last_seen', newest);
  return { filed, newest };
}

module.exports = { detectDevQuestion, record, recentEntries, buildBlock, syncFromGit, DEV_TERMS, DEV_DIRECT };
