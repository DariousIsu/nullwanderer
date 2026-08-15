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

/**
 * The deterministic evidence bundle for a repair need. Parses the born_from signature
 * (self-audit:<detector>:<file>); a self-watch signature has no file → log-tail evidence only.
 * Fail-soft per section; '' when nothing gathers (the caller opens unstudied, honestly).
 */
function preGather(need, { deps = {} } = {}) {
  const bf = String((need && need.born_from) || '');
  let detector = null, rel = null;
  const m = bf.match(/^self-audit:([^:]+):(.+)$/);
  if (m) { detector = m[1]; rel = _safeRel(m[2]); }
  const sections = [];
  if (rel) {
    const f = _fileSection(rel); if (f) sections.push(f);
    const g = _gitSection(rel, deps); if (g) sections.push(g);
  }
  const l = _logSection(rel, detector); if (l) sections.push(l);
  return sections.join('\n\n').slice(0, BUNDLE_CAP);
}

/** The one model pass — diagnosis over evidence, never a fix, never a web search. */
function diagnosisPrompt(need, bundle) {
  return `DIAGNOSIS ONLY — do not build, fix, or search the web. Your own source audit found this defect in YOUR OWN program: "${String((need && need.need) || '').slice(0, 300)}".

EVIDENCE (gathered deterministically from your own repo and logs):
${bundle || '(no evidence gathered — reason from the finding text alone and say exactly which files to inspect)'}

Reply in at most 1200 chars: (1) the ROOT CAUSE in 2-3 sentences, (2) the MINIMAL repair, (3) an exact FILE:LINE citation for every claim (e.g. lib/x.js:42). If the evidence is insufficient to be sure, say precisely what to inspect next, with file paths — never guess a cause.`;
}

// A diagnosis must cite her own code (file:line), not the open web, and must not be narration.
function validateDiagnosis(text) {
  const t = String(text || '').trim();
  if (t.length < 60) return false;
  if (!/[\w./\\-]+\.(?:js|py|md):\d+/.test(t)) return false;                 // at least one FILE:LINE
  try { if (require('./canvas_command').isNarration(t)) return false; } catch {}
  return true;
}

module.exports = { isRepairNeed, preGather, diagnosisPrompt, validateDiagnosis, _safeRel, BUNDLE_CAP };
