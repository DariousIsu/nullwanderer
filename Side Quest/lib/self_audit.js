/**
 * lib/self_audit.js — Stage 1 of the NATIVE SELF-REPAIR LOOP (2026-08-15, Lucas: "these
 * diagnostics you are running should all be native in the program").
 *
 * IDENTIFY: until now the identify link only watched runtime exhaust (self_watch reads logs +
 * stores) — her own SOURCE was never an audit surface; every built-and-dark organ, fail-open
 * gate, and dead meta key waited for an external deep-dive to find it. This organ runs the same
 * sweep MECHANICALLY: seven deterministic detectors over lib/ + main.js + scripts/, zero model
 * calls, on a daily clock.
 *
 * The seven detectors (each mirrors a defect class an external review actually caught):
 *   1. zero-caller-export   — a lib export no live code references (smoke-only = still dark:
 *                             the calendar setProvider class, found by hand 08-15)
 *   2. unread-meta-key      — setMeta keys nothing ever getMeta-reads (built-and-dark data)
 *   3. orphan-env-flag      — ZOE_* env reads absent from .env.example and docs/ (undocumented doors)
 *   4. advertised-lane      — a `[prefix]` log line promised in a watch/acceptance comment that no
 *                             console call ever emits (advertised ≠ emitted)
 *   5. live-claim           — a header claiming LIVE/WIRED over a body still carrying TODO/STUBBED
 *   6. fail-open-gate       — a catch in a gate-named file that returns allow (the tier-gate
 *                             disease #1); documented fail-opens ("fails open") are skipped
 *   7. ungated-smoke        — a RECENT smoke (<14d) not registered in run_smokes.js (older ones
 *                             are the curated live-integration set, deliberate)
 *
 * FINDINGS BECOME WORK through the SAME capped need door as self_watch: a finding must recur on
 * ≥2 passes ≥20h apart before it can mint; ≤1 mint per pass; ≤2 open self-audit-born needs at
 * once; born_from `self-audit:<detector>:<file>` so capability_need's born_from dedup folds
 * repeats. One obs_bus summary per pass (visibility first). The corpus source is injectable so
 * the smoke feeds synthetic defect files.
 *
 * Stage 2 (class-branched diagnosis study), Stage 3 (staged patches, Lucas's approval door), and
 * Stage 4 (never-loaded-file grant) build on this — nothing here writes code, only findings.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DUE_MS = 24 * 3600e3;
const RECUR_MIN_GAP_MS = 20 * 3600e3;
const MAX_OPEN_AUDIT_NEEDS = 2;
const SEEN_KEY = 'self_audit.seen';
const LAST_KEY = 'self_audit.last_at';
const SEEN_CAP = 500;
const SMOKE_RECENT_MS = 14 * 24 * 3600e3;

function _db(deps) { return (deps && deps.db) || require('./db'); }

// ── corpus ────────────────────────────────────────────────────────────────────────────────────
// { files: { relPath: { text, mtimeMs } }, docsText } — lib/*.js + main.js + studio/*.js +
// scripts/*.js (smokes included: they count as "covered by smoke only", not as live callers).
function collectCorpus({ root = path.join(__dirname, '..') } = {}) {
  const files = {};
  const rd = (dir, rel) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (!n.endsWith('.js')) continue;
      const p = path.join(dir, n);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && st.size < 3 * 1048576) files[`${rel}/${n}`] = { text: fs.readFileSync(p, 'utf8'), mtimeMs: st.mtimeMs };
      } catch {}
    }
  };
  rd(path.join(root, 'lib'), 'lib');
  rd(path.join(root, 'studio'), 'studio');
  rd(path.join(root, 'scripts'), 'scripts');
  try { const st = fs.statSync(path.join(root, 'main.js')); files['main.js'] = { text: fs.readFileSync(path.join(root, 'main.js'), 'utf8'), mtimeMs: st.mtimeMs }; } catch {}
  let docsText = '';
  try { for (const n of fs.readdirSync(path.join(root, 'docs'))) { if (n.endsWith('.md')) { try { docsText += fs.readFileSync(path.join(root, 'docs', n), 'utf8'); } catch {} } } } catch {}
  try { docsText += fs.readFileSync(path.join(root, '.env.example'), 'utf8'); } catch {}
  return { files, docsText };
}

const _liveFiles = (corpus) => Object.keys(corpus.files).filter((p) => !p.startsWith('scripts/'));
const _cap = (arr, n) => arr.slice(0, n);

// ── the seven detectors (each: corpus → findings [{detector, file, name, text}]) ──────────────
function detectZeroCallerExports(corpus) {
  const out = [];
  for (const f of Object.keys(corpus.files).filter((p) => p.startsWith('lib/'))) {
    const m = corpus.files[f].text.match(/module\.exports\s*=\s*\{([\s\S]*?)\}/);
    if (!m) continue;
    const names = m[1].split(',').map((s) => (s.split(':')[0] || '').trim()).filter((s) => /^[A-Za-z_$][\w$]*$/.test(s) && s.length >= 5 && !s.startsWith('_'));
    for (const name of names) {
      // Escape regex metachars + use IDENTIFIER boundaries (2026-08-15 backcheck fix): the name
      // filter permits `$` (a valid JS identifier char), but `\b${name}\b` treats a `$` in the name
      // as an anchor and mis-anchors at word boundaries around it — a `$`-containing export never
      // matched its real call sites and was falsely flagged as dark. `(?<![\w$])name(?![\w$])`
      // treats `$` as part of the identifier, which is the correct boundary.
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = new RegExp(`(?<![\\w$])${esc}(?![\\w$])`);
      let live = false, smokeOnly = false;
      for (const [p, { text }] of Object.entries(corpus.files)) {
        if (p === f) continue;
        if (rx.test(text)) { if (p.startsWith('scripts/')) smokeOnly = true; else { live = true; break; } }
      }
      if (!live) out.push({ detector: 'zero-caller-export', file: f, name, text: `${f} exports ${name}() and no live code calls it${smokeOnly ? ' (smoke-only — dark in the running program, the setProvider class)' : ' (no callers anywhere)'}` });
    }
  }
  return _cap(out, 10);
}

function detectUnreadMetaKeys(corpus) {
  const writes = new Map(), reads = new Set(), readPrefixes = [], writeFiles = new Map();
  for (const [p, { text }] of Object.entries(corpus.files)) {
    if (p.startsWith('scripts/')) continue;   // smokes exercise keys; they don't make them read
    for (const m of text.matchAll(/\bsetMeta\(\s*['"]([\w.$\-]+)['"]/g)) { writes.set(m[1], true); if (!writeFiles.has(m[1])) writeFiles.set(m[1], p); }
    for (const m of text.matchAll(/\bgetMeta\(\s*['"]([\w.$\-]+)['"]/g)) reads.add(m[1]);
    for (const m of text.matchAll(/\bgetMeta\(\s*`([^$`]{2,})\$\{/g)) readPrefixes.push(m[1]);
  }
  const out = [];
  for (const k of writes.keys()) {
    if (reads.has(k)) continue;
    if (readPrefixes.some((pf) => k.startsWith(pf))) continue;
    out.push({ detector: 'unread-meta-key', file: writeFiles.get(k) || '?', name: k, text: `meta key "${k}" is written (${writeFiles.get(k)}) and NEVER read — built-and-dark data` });
  }
  return _cap(out, 10);
}

function detectOrphanEnvFlags(corpus) {
  const out = [], seen = new Set();
  for (const [p, { text }] of Object.entries(corpus.files)) {
    if (p.startsWith('scripts/')) continue;
    for (const m of text.matchAll(/process\.env\.(ZOE_[A-Z0-9_]+)/g)) {
      const flag = m[1];
      if (seen.has(flag)) continue;
      seen.add(flag);
      if (!corpus.docsText.includes(flag)) out.push({ detector: 'orphan-env-flag', file: p, name: flag, text: `env flag ${flag} (read in ${p}) appears in no doc and no .env.example — an undocumented door` });
    }
  }
  return _cap(out, 5);
}

function detectAdvertisedLanes(corpus) {
  const emitted = new Set(), advertised = new Map();
  for (const [p, { text }] of Object.entries(corpus.files)) {
    for (const m of text.matchAll(/console\.(?:log|warn|error)\(\s*[`'"]\s*\[([a-z][a-z0-9_-]{2,20})\]/g)) emitted.add(m[1]);
    if (p.startsWith('scripts/')) continue;
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!(t.startsWith('//') || t.startsWith('*'))) continue;
      if (!/watch for|acceptance|tells?:|log line|logs `?\[/i.test(t)) continue;
      for (const m of t.matchAll(/\[([a-z][a-z0-9_-]{2,20})\]/g)) { if (!advertised.has(m[1])) advertised.set(m[1], p); }
    }
  }
  const out = [];
  for (const [lane, p] of advertised) {
    if (!emitted.has(lane)) out.push({ detector: 'advertised-lane', file: p, name: lane, text: `a comment in ${p} promises the log line "[${lane}] …" as a watch-for and NO console call ever emits that prefix — advertised ≠ emitted` });
  }
  return _cap(out, 5);
}

function detectLiveClaims(corpus) {
  const out = [];
  for (const [p, { text }] of Object.entries(corpus.files)) {
    if (p.startsWith('scripts/') || p === 'main.js') continue;   // main is a mixed bag by nature
    const header = text.split('\n').slice(0, 40).join('\n');
    if (!/\b(LIVE|WIRED|CONNECTED)\b/.test(header)) continue;
    const marker = text.match(/\b(TODO|FIXME|STUBBED|NOT YET WIRED|NEVER CALLED)\b/);
    if (marker) out.push({ detector: 'live-claim', file: p, name: marker[1], text: `${p}'s header claims LIVE/WIRED while its body still carries "${marker[1]}" — the claim and the code disagree; verify which is true` });
  }
  return _cap(out, 5);
}

function detectFailOpenGates(corpus) {
  const out = [];
  for (const [p, { text }] of Object.entries(corpus.files)) {
    if (!/gate|guard|tier|policy|quota/.test(p) || p.startsWith('scripts/')) continue;
    for (const m of text.matchAll(/catch[\s\S]{0,160}?(allow:\s*true|return\s+true)/g)) {
      // Scan the 300 chars BEFORE the catch PLUS the rest of the CURRENT LINE (2026-08-15 backcheck
      // fix): a "fails open" note placed INLINE on the return line (`catch(e){ return true; /* fails
      // open */ }`) sits after the match and was missed → the documented gate got wrongly flagged.
      // End-of-line (not a fixed after-window) is deliberate: it catches the same-line note WITHOUT
      // reaching a following function's leading comment (which would suppress a real undocumented
      // fail-open on THIS catch). A header-level note is still caught by the 300-before window in the
      // small gate files where it matters.
      const lineEnd = text.indexOf('\n', m.index);
      const around = text.slice(Math.max(0, m.index - 300), lineEnd === -1 ? text.length : lineEnd);
      if (/fails?[ -]open/i.test(around)) continue;   // documented = a design choice, not a finding
      const line = text.slice(0, m.index).split('\n').length;
      out.push({ detector: 'fail-open-gate', file: p, name: `L${line}`, text: `${p}:${line} — a catch in a gate-named file returns ALLOW with no "fails open" doc comment; an error there silently opens the gate (the tier-gate disease class)` });
    }
  }
  return _cap(out, 5);
}

function detectUngatedSmokes(corpus, { nowMs = Date.now() } = {}) {
  const runner = corpus.files['scripts/run_smokes.js'];
  if (!runner) return [];
  const out = [];
  for (const [p, { mtimeMs }] of Object.entries(corpus.files)) {
    const base = path.basename(p);
    if (!p.startsWith('scripts/') || !base.startsWith('smoke_')) continue;
    if ((nowMs - mtimeMs) > SMOKE_RECENT_MS) continue;                 // old ungated = the curated live set
    if (!runner.text.includes(`'${base}'`)) out.push({ detector: 'ungated-smoke', file: p, name: base, text: `${base} is RECENT (<14d) and not registered in run_smokes.js — a new smoke outside the gate protects nothing` });
  }
  return _cap(out, 5);
}

function runDetectors(corpus, { nowMs = Date.now() } = {}) {
  const all = [];
  for (const fn of [detectZeroCallerExports, detectUnreadMetaKeys, detectOrphanEnvFlags, detectAdvertisedLanes, detectLiveClaims, detectFailOpenGates]) {
    try { all.push(...fn(corpus)); } catch {}
  }
  try { all.push(...detectUngatedSmokes(corpus, { nowMs })); } catch {}
  return all;
}

// ── the pass: detect → recurrence ledger → capped mint door ───────────────────────────────────
function due({ deps = {}, nowMs = Date.now() } = {}) {
  try { const last = parseInt(_db(deps).getMeta(LAST_KEY) || '0', 10) || 0; return (nowMs - last) >= DUE_MS; } catch { return false; }
}

function runPass({ deps = {}, nowMs = Date.now(), corpus = null } = {}) {
  const db = _db(deps);
  try { db.setMeta(LAST_KEY, String(nowMs)); } catch {}
  const c = corpus || collectCorpus({});
  const findings = runDetectors(c, { nowMs });
  return ingestFindings(findings, { deps, nowMs });
}

/**
 * The LIVE entry: sweep in a CHILD process (the real-repo sweep measures ~8s — synchronous on the
 * main thread that is a daily stall, the exact disease this organ hunts), then ledger/mint/obs in
 * the parent (cheap). Stamps the clock immediately so a slow child can't double-spawn.
 */
function spawnPass({ deps = {}, nowMs = Date.now() } = {}) {
  const db = _db(deps);
  try { db.setMeta(LAST_KEY, String(nowMs)); } catch {}
  try {
    const { execFile } = require('child_process');
    const script = path.join(__dirname, '..', 'scripts', 'self_audit_pass.js');
    const child = execFile(process.execPath, [script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 5 * 60e3, windowsHide: true, maxBuffer: 4 * 1048576,
    }, (err, stdout) => {
      try {
        if (err) { console.error('[self-audit] child sweep failed:', err.message); return; }
        let out = null;
        try { out = JSON.parse(String(stdout || '').trim().split('\n').pop()); } catch {}
        if (!out || !Array.isArray(out.findings)) { console.error('[self-audit] child sweep returned no findings payload'); return; }
        ingestFindings(out.findings, { deps, nowMs: Date.now() });
      } catch (e) { console.error('[self-audit] ingest failed:', e.message); }
    });
    if (child.unref) child.unref();
    return true;
  } catch (e) { console.error('[self-audit] spawn failed:', e.message); return false; }
}

// ledger + capped mint + obs summary — shared by the sync path (smokes) and the child path (live).
function ingestFindings(findings, { deps = {}, nowMs = Date.now() } = {}) {
  const db = _db(deps);
  // recurrence ledger — a finding mints only when seen on ≥2 passes ≥20h apart (one-pass noise never mints)
  let seen = {};
  try { seen = JSON.parse(db.getMeta(SEEN_KEY) || '{}') || {}; } catch {}
  const mintable = [];
  for (const f of findings) {
    const sig = `${f.detector}:${f.file}:${f.name}`.slice(0, 160);
    const s = seen[sig] || { count: 0, firstAt: nowMs, lastAt: 0 };
    if ((nowMs - s.lastAt) >= RECUR_MIN_GAP_MS) { s.count += 1; s.lastAt = nowMs; }
    seen[sig] = s;
    if (s.count >= 2) mintable.push({ ...f, sig });
  }
  // prune ledger entries not seen this pass beyond the cap
  const sigsNow = new Set(findings.map((f) => `${f.detector}:${f.file}:${f.name}`.slice(0, 160)));
  const keys = Object.keys(seen);
  if (keys.length > SEEN_CAP) for (const k of keys) { if (!sigsNow.has(k)) { delete seen[k]; if (Object.keys(seen).length <= SEEN_CAP) break; } }
  try { db.setMeta(SEEN_KEY, JSON.stringify(seen)); } catch {}
  // the capped mint door (same shape as self_watch): ≤2 open audit-born needs, ≤1 mint per pass
  let minted = null;
  try {
    const cn = (deps.capabilityNeed) || require('./capability_need');
    const open = (cn.listOpen({ deps }) || []).filter((n) => String(n.born_from || '').startsWith('self-audit:'));
    if (open.length < MAX_OPEN_AUDIT_NEEDS && mintable.length) {
      const f = mintable[0];
      const r = cn.record(`I need a fix for a defect my own source audit found: ${f.text}`, { bornFrom: f.sig.startsWith('self-audit:') ? f.sig : `self-audit:${f.detector}:${f.file}`, deps, nowMs, similarFloor: 0.75 });
      if (r && r.id != null && !r.deduped) {
        minted = { id: r.id, sig: f.sig };
        try { console.log(`[self-audit] recurring finding → opened need #${r.id}: ${f.text.slice(0, 110)}`); } catch {}
      }
    }
  } catch {}
  // one obs summary per pass — visibility first
  try {
    const byDet = {};
    for (const f of findings) byDet[f.detector] = (byDet[f.detector] || 0) + 1;
    ((deps.obsBus) || require('./obs_bus')).emit({
      lane: 'audit', kind: 'self_audit', level: findings.length ? 'warn' : 'info',
      text: findings.length
        ? `self-audit: ${findings.length} finding(s) — ${Object.entries(byDet).map(([k, v]) => `${k}×${v}`).join(' ')}${minted ? ` · minted need #${minted.id}` : ''} (${mintable.length} recurred)`
        : 'self-audit: source sweep clean',
      data: { counts: byDet, recurred: mintable.length, minted: minted && minted.id },
    }, { deps, nowMs });
  } catch {}
  return { findings, mintable, minted };
}

module.exports = {
  collectCorpus, runDetectors, runPass, spawnPass, ingestFindings, due,
  detectZeroCallerExports, detectUnreadMetaKeys, detectOrphanEnvFlags, detectAdvertisedLanes,
  detectLiveClaims, detectFailOpenGates, detectUngatedSmokes,
  DUE_MS, RECUR_MIN_GAP_MS, MAX_OPEN_AUDIT_NEEDS, SEEN_KEY, LAST_KEY,
};
