/**
 * lib/diagnosis.js — Stage 2 of the NATIVE SELF-REPAIR LOOP (2026-08-15): the CLASS-BRANCHED
 * study. The R2 study pass is right for SKILLS (web patterns + a URL-demand validator) and
 * wrong-shaped for REPAIRS: a defect in her own source needs no web search — it needs the
 * implicated code, the file's recent history, and the live log, then a diagnosis that cites
 * FILE:LINE instead of URLs. A repair "study" that passed the URL gate would be pattern-matched
 * blog reading about someone else's program.
 *
 * PRE-GATHER is deterministic and free (no model, no slot): the implicated file's head + size
 * (path strictly confined to the repo's own source dirs), its recent git history, and the newest
 * boot log's lines touching it. The ONE model pass then diagnoses over evidence instead of
 * searching for it — the same shape as every other loop in this build: tokens move from finding
 * to comprehending. validateDiagnosis demands at least one FILE:LINE citation and refuses
 * narration, mirroring the M6.3 payload contract on the skill side.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BUNDLE_CAP = 2200;

// A repair need = born from her own instruments watching her own program.
function isRepairNeed(need) {
  const bf = String((need && need.born_from) || '');
  return bf.startsWith('self-audit:') || bf.startsWith('self-watch:');
}

// Strictly confine any file named in a signature to the repo's own source surface.
function _safeRel(rel) {
  const r = String(rel || '').replace(/\\/g, '/').trim();
  if (!r || r.includes('..') || !/^(lib|studio|scripts|renderer)\/[\w./-]+\.js$|^main\.js$/.test(r)) return null;
  return r;
}

function _fileSection(rel) {
  try {
    const p = path.join(ROOT, rel);
    const st = fs.statSync(p);
    const head = fs.readFileSync(p, 'utf8').split('\n').slice(0, 30).join('\n');
    return `IMPLICATED FILE ${rel} (${Math.round(st.size / 1024)}KB) — first 30 lines:\n${head}`;
  } catch { return null; }
}

function _gitSection(rel, { execFileSync = null } = {}) {
  try {
    const ex = execFileSync || require('child_process').execFileSync;
    const out = ex('git', ['log', '--oneline', '-5', '--', rel], { cwd: ROOT, encoding: 'utf8', timeout: 10000, windowsHide: true });
    const t = String(out || '').trim();
    return t ? `RECENT HISTORY of ${rel} (git log -5):\n${t}` : null;
  } catch { return null; }
}

function _logSection(rel, detector) {
  try {
    const dataDir = path.join(ROOT, 'data');
    const logs = fs.readdirSync(dataDir).filter((n) => /^boot_p\d+\.log$/.test(n)).sort((a, b) => (parseInt(b.match(/\d+/)[0], 10) - parseInt(a.match(/\d+/)[0], 10)));
    if (!logs.length) return null;
    const p = path.join(dataDir, logs[0]);
    const size = fs.statSync(p).size;
    const fd = fs.openSync(p, 'r');
    const len = Math.min(size, 128 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const keys = [rel ? path.basename(rel, '.js') : null, detector || null].filter(Boolean);
    if (!keys.length) return null;
    const hits = buf.toString('utf8').split('\n').filter((l) => keys.some((k) => l.includes(k))).slice(-10);
    return hits.length ? `LIVE LOG (${logs[0]}, lines touching ${keys.join('/')}):\n${hits.join('\n')}` : null;
  } catch { return null; }
}

// ── IMPLICATED-CODE SEARCH (Lucas 08-27: repairs BUILT FROM REAL CODE) ─────────────────────────
// A self-watch signature names no file ("[doc-extract] worker job failed → DOMMatrix is not
// defined"), so the evidence bundle used to be log-tail only and the diagnosis leaned on the
// model's prior. Deterministic cure: pull the signature's DISTINCTIVE tokens and grep the repo's
// own source for them — the files that carry the token ARE the implicated code. Bounded, no model.
const _TOKEN_STOP = new Set(['recurring', 'failure', 'program', 'process', 'worker', 'defined', 'exceeded', 'abandoned', 'continues', 'failed', 'error', 'undefined', 'cannot', 'timeout', 'dispatch', 'request', 'message', 'module', 'function']);
function _sigTokens(text) {
  const toks = [...new Set(String(text || '').match(/[A-Za-z_$][\w$-]{5,}/g) || [])]
    .filter((t) => !_TOKEN_STOP.has(t.toLowerCase()));
  // rare-looking first: midword caps / dashes / underscores are code-ish identifiers
  return toks.sort((a, b) => (/[A-Z].*[A-Z]|[-_]/.test(b) ? 1 : 0) - (/[A-Z].*[A-Z]|[-_]/.test(a) ? 1 : 0)).slice(0, 3);
}
function _findImplicated(needText, { maxFiles = 3 } = {}) {
  const tokens = _sigTokens(needText);
  if (!tokens.length) return [];
  const hits = [];
  try {
    const dirs = [['lib', path.join(ROOT, 'lib')], ['studio', path.join(ROOT, 'studio')], ['', ROOT]];
    for (const [prefix, dir] of dirs) {
      let names = [];
      try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.js')); } catch { continue; }
      if (!prefix) names = names.filter((n) => n === 'main.js');
      for (const n of names) {
        if (hits.length >= maxFiles) return hits;
        try {
          const body = fs.readFileSync(path.join(dir, n), 'utf8');
          if (tokens.some((t) => body.includes(t))) hits.push(prefix ? `${prefix}/${n}` : n);
        } catch {}
      }
    }
  } catch {}
  return hits;
}

/**
 * The deterministic evidence bundle for a repair need. Parses the born_from signature
 * (self-audit:<detector>:<file>); a self-watch signature has no file → the implicated-code
 * SEARCH finds the files that carry the signature's distinctive tokens (real code in the
 * bundle, never a prior). Fail-soft per section; '' when nothing gathers (opens unstudied).
 */
function preGather(need, { deps = {} } = {}) {
  const bf = String((need && need.born_from) || '');
  let detector = null, rel = null;
  const m = bf.match(/^self-audit:([^:]+):(.+)$/);
  if (m) { detector = m[1]; rel = _safeRel(m[2]); }
  const sections = [];
  let rels = rel ? [rel] : [];
  if (!rels.length) rels = _findImplicated(String((need && need.need) || bf)).map(_safeRel).filter(Boolean);
  for (const r of rels.slice(0, 2)) {
    const f = _fileSection(r); if (f) sections.push(f);
    const g = _gitSection(r, deps); if (g) sections.push(g);
  }
  const l = _logSection(rel || rels[0] || null, detector); if (l) sections.push(l);
  return sections.join('\n\n').slice(0, BUNDLE_CAP);
}

// A rehearsal run advancing a repair-born need — grandfathered from before the repair lane
// existed. The lane filters repair ROWS out of the tool pipe, but the iterate branch keys on the
// loaded RUN, so a pre-cure run kept advancing (need #94 schema-failed 103x/7d against its own
// failure count). The needs array is listOpen() = status 'open' ONLY, and a run-backed row sits in
// 'rehearsing' — invisible there (the v1 miss, caught live on p175) — so an absent row falls back
// to the direct getNeed lookup. Returns the need row when the run should be discarded, else null.
function isRepairRunFor(run, needs, { getNeed = null } = {}) {
  const m = run && run.slug && String(run.slug).match(/^need-(\d+)-/);
  if (!m) return null;
  const id = parseInt(m[1], 10);
  let row = (needs || []).find((n) => n && n.id === id);
  if (!row && typeof getNeed === 'function') { try { row = getNeed(id); } catch {} }
  return row && isRepairNeed(row) ? row : null;
}

/** The one model pass — diagnosis over evidence, never a fix, never a web search. */
function diagnosisPrompt(need, bundle) {
  return `DIAGNOSIS ONLY — do not build, fix, or search the web. Your own source audit found this defect in YOUR OWN program: "${String((need && need.need) || '').slice(0, 300)}".

EVIDENCE (gathered deterministically from your own repo and logs):
${bundle || '(no evidence gathered — reason from the finding text alone and say exactly which files to inspect)'}

Reply in at most 1200 chars: (1) the ROOT CAUSE in 2-3 sentences, (2) the MINIMAL repair, (3) an exact FILE:LINE citation for every claim (e.g. lib/x.js:42). If the evidence is insufficient to be sure, say precisely what to inspect next, with file paths — never guess a cause.`;
}

// A diagnosis must cite her own code (file:line), not the open web, and must not be narration —
// and (Lucas 08-27: real code, real citations) every repo-shaped citation must point at code that
// EXISTS: a cited file that isn't on disk, or a line past EOF, is a hallucinated citation and
// invalidates the whole diagnosis. Non-repo paths (node:internal, package internals) are ignored.
function validateDiagnosis(text) {
  const t = String(text || '').trim();
  if (t.length < 60) return false;
  const cites = t.match(/[\w./\\-]+\.(?:js|py|md):\d+/g) || [];
  if (!cites.length) return false;                                           // at least one FILE:LINE
  try { if (require('./canvas_command').isNarration(t)) return false; } catch {}
  for (const c of cites) {
    const [, file, line] = c.match(/^(.*):(\d+)$/) || [];
    const rel = _safeRel(file);
    if (!rel) continue;                                                      // not repo-shaped → not ours to verify
    try {
      const body = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      if (parseInt(line, 10) > body.split('\n').length) return false;        // line past EOF = hallucinated
    } catch { return false; }                                                // repo-shaped but absent = hallucinated
  }
  return true;
}

// ── STUDY CITATION VERIFICATION (Lucas 08-27: capability builds from REAL SOURCED CITES) ───────
// The skill-study validator only checked that URLs were PRESENT — a hallucinated URL passed. The
// site ledger records every page she actually fetches, so "cited" is checkable against "read":
// a study citing pages the ledger has never seen is composed, not sourced. Requires ≥1 cited URL
// ledger-verified; returns the split so the caller can log the unverified tail.
function verifyStudyCitations(study, { deps = {} } = {}) {
  const urls = [...new Set(String(study || '').match(/https?:\/\/[^\s"'<>)\]]+/g) || [])].slice(0, 8);
  if (!urls.length) return { ok: false, verified: [], unverified: [], reason: 'no source URLs' };
  const sl = (deps && deps.siteLedger) || require('./site_ledger');
  const verified = [], unverified = [];
  for (const u of urls) {
    let row = null; try { row = sl.seen(u); } catch {}
    (row ? verified : unverified).push(u);
  }
  return { ok: verified.length >= 1, verified, unverified, reason: verified.length ? null : 'cited URLs were never actually read (no site-ledger record)' };
}

module.exports = { isRepairNeed, isRepairRunFor, preGather, diagnosisPrompt, validateDiagnosis, verifyStudyCitations, _findImplicated, _sigTokens, _safeRel, BUNDLE_CAP };
