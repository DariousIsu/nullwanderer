/**
 * Recipe store — loads the JSON flow recipes in <app>/recipes/ that flow_runner.js
 * replays. Each file is one { site, task, fingerprint?, steps } recipe. Hand-authored
 * for the high-value stable sites (Substack / Google Calendar / Google Drive); the
 * long tail will be captured by an in-process recorder later.
 *
 * Selectors in a freshly hand-authored recipe are PROVISIONAL until a live run
 * confirms (or the heal ladder repairs) them — recipes carry a "verified" flag so
 * the runner/UI can tell a confirmed recipe from a best-effort first draft.
 */

const fs = require('fs');
const path = require('path');

const RECIPES_DIR = path.join(__dirname, '..', 'recipes');

function _files() {
  try { return fs.readdirSync(RECIPES_DIR).filter(f => f.endsWith('.json')); }
  catch { return []; }
}

// Load one recipe by file stem (e.g. 'substack_publish'). Returns the parsed object
// or null (missing / unparseable — never throws).
function load(name) {
  const file = path.join(RECIPES_DIR, name.endsWith('.json') ? name : `${name}.json`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

// All recipes (parsed). Skips any file that fails to parse.
function all() {
  return _files().map(f => load(f)).filter(Boolean);
}

// Find the recipe for a (site, task) pair. site match is a substring (so
// "substack.com" matches a recipe sited at "substack.com").
function find(site, task) {
  const s = String(site || '').toLowerCase();
  const t = String(task || '').toLowerCase();
  return all().find(r =>
    (!s || String(r.site || '').toLowerCase().includes(s) || s.includes(String(r.site || '').toLowerCase())) &&
    (!t || String(r.task || '').toLowerCase() === t)
  ) || null;
}

// List {site, task, verified, steps} summaries for the UI / her self-knowledge.
function list() {
  return all().map(r => ({ site: r.site, task: r.task, verified: !!r.verified, steps: (r.steps || []).length }));
}

module.exports = { load, all, find, list, RECIPES_DIR };
