'use strict';
/**
 * lib/organ_atlas.js — THE ORGAN ATLAS (the wants project's cut 11; her words: "You can't meaningfully own something you
 * can't see." Lucas 09-05: "lets get continue with the rest of the open cuts").
 *
 * MEASURED FIRST (09-05 ~19:55): 500 organs on the lib shelf; 132 log under a `[prefix]`; 53 carry a ZOE_ switch; 61
 * write meta keys; 416 have a same-named smoke (30 prefixed organs do not). The self audit's corpus already holds every
 * file's text; its detectors parse exports, meta keys and env flags — the atlas is a read model over the same corpus.
 *
 * A seeded TABLE of organs — { organ, file, owner_lane, kill_switch, meta_keys, smoke, log_prefix, header, exports } —
 * kept current by the self audit's pass (seed() re-scans; an entry whose file is gone is marked stale and reported as a
 * finding, never deleted). Served two ways: self_source.sourceMap ranks the organ a question names first (rankBoost),
 * and the operator brief carries the atlas line when a self-question names an organ (lookup / line). "Which organ owns
 * my mood" resolves to lib/mood.js, its switch, its smoke and its prefix. Pure over an injected corpus; the store is
 * its own table (injectable for the smoke).
 */

const path = require('path');

const PREFIX_RE = /console\.(?:log|warn|error)\(\s*[`'"]\[([^\]\n`'"$]{2,30})\]/g;   // a literal [prefix] at the head of a console line; a template prefix is not a prefix
const SWITCH_RE = /process\.env\.(ZOE_[A-Z0-9_]+)/g;
const META_RE = /\b(?:getMeta|setMeta)\(\s*['"]([\w.$\-:]{3,60})['"]/g;
const LANE_RE = /\blane:\s*'([a-z_][a-z0-9_\-]{1,30})'/g;
const STOP = new Set(['which', 'what', 'organ', 'module', 'file', 'part', 'owns', 'own', 'handles', 'handle', 'runs', 'run', 'does', 'is', 'my', 'your', 'the', 'of', 'you', 'code', 'program', 'where', 'live', 'lives', 'kept', 'coded', 'that', 'this', 'for', 'and', 'her', 'his', 'how', 'who', 'responsible', 'switch', 'off', 'turn', 'kill']);

/** One organ's row from its source text. */
function scanFile(rel, text, { smokes = new Set() } = {}) {
  const stem = path.basename(rel, '.js');
  const uniq = (re, i = 1) => { const out = []; const seen = new Set(); for (const m of String(text).matchAll(re)) { const v = m[i]; if (!seen.has(v)) { seen.add(v); out.push(v); } } return out; };
  const head = String(text).slice(0, 700);
  const hm = head.match(/\/\*\*?\s*\n?\s*\*?\s*([^\n*][^\n]*)/) || head.match(/^\/\/\s*(.+)$/m);
  const exp = (String(text).match(/module\.exports\s*=\s*\{([\s\S]*?)\}/) || [, ''])[1].split(',').map((s) => (s.split(':')[0] || '').trim()).filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
  const lanes = uniq(LANE_RE);
  return {
    organ: stem, file: rel,
    header: hm ? hm[1].replace(/\s+/g, ' ').trim().slice(0, 140) : '',
    log_prefix: uniq(PREFIX_RE).map((p) => p.toLowerCase()),
    kill_switch: uniq(SWITCH_RE),
    meta_keys: uniq(META_RE),
    owner_lane: lanes[0] || (/worker_threads/.test(text) ? 'worker' : 'main'),
    smoke: smokes.has(`smoke_${stem}.js`) ? `scripts/smoke_${stem}.js` : null,
    exports: exp.slice(0, 40),
  };
}

/** Every lib organ in the corpus (the self audit's collectCorpus shape: { files: { 'lib/x.js': { text } } }). */
function scan({ corpus } = {}) {
  const files = (corpus && corpus.files) || {};
  const smokes = new Set(Object.keys(files).filter((p) => p.startsWith('scripts/smoke_')).map((p) => path.basename(p)));
  return Object.keys(files).filter((p) => p.startsWith('lib/') && p.endsWith('.js')).sort().map((p) => scanFile(p, files[p].text, { smokes }));
}

// ── the store (injectable) ─────────────────────────────────────────────────────────────────────────────────
let _dbh = null;
function _setDb(h) { _dbh = h; _ensured = false; }
function _handle() { return _dbh || require('./db').getDb(); }
let _ensured = false;
function ensure() {
  const h = _handle();
  if (_ensured && !_dbh) return;
  h.exec(`CREATE TABLE IF NOT EXISTS organ_atlas (
    organ TEXT PRIMARY KEY,
    file TEXT NOT NULL,
    owner_lane TEXT,
    kill_switch TEXT,
    meta_keys TEXT,
    smoke TEXT,
    log_prefix TEXT,
    header TEXT,
    exports_n INTEGER,
    updated_ts INTEGER,
    seen_ts INTEGER,
    stale INTEGER DEFAULT 0
  )`);
  _ensured = true;
}
const J = (a) => JSON.stringify(a || []);
const P = (s) => { try { return JSON.parse(s || '[]') || []; } catch { return []; } };

/**
 * Seed or refresh the table from the corpus: every scanned organ upserted (stale 0, seen now); a row whose file is no
 * longer on the shelf is marked stale (never deleted) and reported as a finding for the self audit.
 * Returns { total, changed, stale: [organ], findings: [{ detector, file, name, text }] }.
 */
function seed({ corpus, now = Date.now() } = {}) { return seedRows({ rows: scan({ corpus }), now }); }
/** The same, from rows a child process scanned (the self audit sweeps in a child; the parent holds the db). */
function seedRows({ rows = [], now = Date.now() } = {}) {
  ensure();
  const h = _handle();
  const up = h.prepare(`INSERT INTO organ_atlas (organ, file, owner_lane, kill_switch, meta_keys, smoke, log_prefix, header, exports_n, updated_ts, seen_ts, stale)
    VALUES (@organ, @file, @owner_lane, @kill_switch, @meta_keys, @smoke, @log_prefix, @header, @exports_n, @now, @now, 0)
    ON CONFLICT(organ) DO UPDATE SET file = excluded.file, owner_lane = excluded.owner_lane, kill_switch = excluded.kill_switch, meta_keys = excluded.meta_keys,
      smoke = excluded.smoke, log_prefix = excluded.log_prefix, header = excluded.header, exports_n = excluded.exports_n, seen_ts = excluded.seen_ts, stale = 0,
      updated_ts = CASE WHEN organ_atlas.kill_switch IS NOT excluded.kill_switch OR organ_atlas.log_prefix IS NOT excluded.log_prefix OR organ_atlas.meta_keys IS NOT excluded.meta_keys OR organ_atlas.smoke IS NOT excluded.smoke THEN excluded.updated_ts ELSE organ_atlas.updated_ts END`);
  let changed = 0;
  const tx = h.transaction((list) => {
    for (const r of list) {
      const prev = h.prepare('SELECT kill_switch, log_prefix, meta_keys, smoke FROM organ_atlas WHERE organ = ?').get(r.organ);
      const rec = { organ: r.organ, file: r.file, owner_lane: r.owner_lane, kill_switch: J(r.kill_switch), meta_keys: J(r.meta_keys), smoke: r.smoke, log_prefix: J(r.log_prefix), header: r.header, exports_n: r.exports.length, now };
      up.run(rec);
      if (!prev || prev.kill_switch !== rec.kill_switch || prev.log_prefix !== rec.log_prefix || prev.meta_keys !== rec.meta_keys || prev.smoke !== rec.smoke) changed++;
    }
  });
  tx(rows);
  const seen = new Set(rows.map((r) => r.organ));
  const stale = h.prepare('SELECT organ, file FROM organ_atlas WHERE seen_ts < ? OR seen_ts IS NULL').all(now).filter((r) => !seen.has(r.organ));
  for (const s of stale) h.prepare('UPDATE organ_atlas SET stale = 1 WHERE organ = ?').run(s.organ);
  const findings = stale.map((s) => ({ detector: 'stale-atlas-entry', file: s.file, name: s.organ, text: `the organ atlas still lists ${s.file} and the file is no longer on the shelf — the entry is stale (kept, marked)` }));
  return { total: rows.length, changed, stale: stale.map((s) => s.organ), findings };
}
function rows() { try { ensure(); return _handle().prepare('SELECT * FROM organ_atlas WHERE stale = 0 ORDER BY organ').all().map(_hydrate); } catch { return []; } }
function get(organ) { try { ensure(); const r = _handle().prepare('SELECT * FROM organ_atlas WHERE organ = ?').get(organ); return r ? _hydrate(r) : null; } catch { return null; } }
function _hydrate(r) { return { ...r, kill_switch: P(r.kill_switch), meta_keys: P(r.meta_keys), log_prefix: P(r.log_prefix), stale: !!r.stale }; }

// ── the questions it answers ───────────────────────────────────────────────────────────────────────────────
/** A self-question naming an organ: "which organ owns my mood", "what file handles your voice", "where is my mood coded". */
function detectOrganQuestion(text) {
  const t = String(text || '').trim();
  if (t.length < 8) return false;
  if (/\b(which|what)\s+(organ|module|file|part of (you|your code|the program))\b[\s\S]{0,80}\b(owns?|handles?|runs?|does|is responsible|controls?|drives?)\b/i.test(t)) return true;
  if (/\bwhere\s+(does|is|are)\s+(my|your)\s+[a-z][a-z _-]{2,40}\s+(live|kept|handled|coded|run|written)\b/i.test(t)) return true;
  if (/\b(how do I|can I|what) (turn|switch|shut) off (my|your|the) [a-z][a-z _-]{2,40}\b/i.test(t)) return true;
  return false;
}
function _tokens(q) { return (String(q || '').toLowerCase().match(/[a-z0-9_]{3,}/g) || []).filter((w) => !STOP.has(w)); }
/** The organ a question names, scored: the organ's name, its prefix, a meta key or switch, its header words. Null under the floor. */
function lookup(question, { rowsIn = null, floor = 30 } = {}) {
  const toks = _tokens(question);
  if (!toks.length) return null;
  const list = rowsIn || rows();
  let best = null;
  // a token hits a name word when they share a stem ("attestation" hits "attest", "organs" hits "organ")
  const hit = (w, t) => w === t || (t.length >= 4 && w.startsWith(t)) || (w.length >= 4 && t.startsWith(w));
  for (const r of list) {
    let score = 0; const why = [];
    const stemWords = r.organ.toLowerCase().split(/[_-]/).filter(Boolean);
    const nameHits = stemWords.filter((w) => toks.some((t) => hit(w, t)));
    if (nameHits.length === stemWords.length) { score += 60 + (stemWords.length > 1 ? 10 : 0); why.push(`its name is ${stemWords.join(' ')}`); }   // the whole name — a two-word organ beats its one-word namesake
    else if (nameHits.length) { score += 25 * nameHits.length; why.push(`${nameHits.join(' and ')} ${nameHits.length === 1 ? 'is' : 'are'} in its name`); }
    for (const t of toks) {
      const tt = t.replace(/s$/, '');
      if ((r.log_prefix || []).some((p) => p === t || p === tt || p.split(/[ _:-]/).includes(t))) { score += 40; why.push(`it logs as [${t}]`); }
      if ((r.kill_switch || []).some((k) => k.toLowerCase().includes(t))) { score += 25; why.push(`a switch names ${t}`); }
      if ((r.meta_keys || []).some((k) => k.toLowerCase().split(/[._:-]/).includes(t))) { score += 20; why.push(`a meta key names ${t}`); }
      if (r.header && new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(r.header)) { score += 8; why.push(`its header says ${t}`); }
      if ((r.exports_n == null ? (r.exports || []) : []).some((e) => hit(String(e).toLowerCase(), t))) { score += 15; why.push(`it exports ${t}`); }
    }
    if (score > (best ? best.score : 0)) best = { ...r, score, why: [...new Set(why)].slice(0, 4) };
  }
  return best && best.score >= floor ? best : null;
}
/** The line for the brief / the reply grounding, or null. */
function line(question, opts = {}) {
  const r = lookup(question, opts);
  if (!r) return null;
  const bits = [`THE ORGAN THIS NAMES: ${r.file}${r.header ? ` — ${r.header}` : ''}`];
  bits.push(`it runs on the ${r.owner_lane} lane`);
  bits.push(r.log_prefix.length ? `it logs as ${r.log_prefix.map((p) => `[${p}]`).join(' ')}` : 'it logs under no prefix of its own');
  bits.push(r.kill_switch.length ? `its switch${r.kill_switch.length > 1 ? 'es' : ''}: ${r.kill_switch.join(', ')}` : 'it has no kill switch');
  bits.push(r.smoke ? `its smoke: ${r.smoke}` : 'it has no smoke of its own');
  if (r.meta_keys.length) bits.push(`its meta keys: ${r.meta_keys.slice(0, 6).join(', ')}${r.meta_keys.length > 6 ? '…' : ''}`);
  return `${bits.join('; ')} (why: ${r.why.join('; ')}). Read it with source_read {"path":"${r.file}"}.`;
}
/** For self_source.sourceMap: the file the focus names gets a rank boost, so the organ leads the map. { rel, boost } or null. */
function rankBoost(focus, opts = {}) { const r = lookup(focus, { floor: 35, ...opts }); return r ? { rel: r.file, boost: 60, organ: r.organ } : null; }

module.exports = { PREFIX_RE, scanFile, scan, ensure, seed, seedRows, rows, get, detectOrganQuestion, lookup, line, rankBoost, _setDb };
