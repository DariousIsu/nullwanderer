'use strict';
/*
 * lib/security_deps.js — security self-audit, increment 3c (2026-09-04): the dependency advisory scanner.
 * The "dependencies" class of the toolkit (design §3: CVE and advisory checks on npm and Python
 * dependencies). Reads the two lockfiles she actually ships on — package-lock.json (npm, lockfile v2/v3)
 * and uv.lock (PyPI) — and asks ONE public advisory database, OSV (api.osv.dev, no key; the aggregator
 * behind GitHub's advisory database and PyPA's), which of those EXACT versions carry a known advisory.
 * A bounded detail fetch then names each advisory (summary, severity, the first fixed version) so the
 * finding proposes a concrete upgrade. Runs on the MAIN thread inside runScanOnce, after the off-thread
 * file walk: the parse is milliseconds, the wait is network.
 *
 * THE NETWORK LINE: this is the one scanner that leaves the host, and it reaches exactly one fixed host,
 * OSV_HOST, to READ a public database about her own manifests. It is a data source, not a test target —
 * the scope allowlist governs what she TESTS, and nothing here tests anything. Package names + versions
 * are all that is sent. fetch is injectable (the smoke runs offline); kill switch ZOE_SECURITY_DEPS=0.
 */
const fs = require('fs');
const path = require('path');

const OSV_HOST = 'https://api.osv.dev';
const BATCH = 500;          // querybatch accepts up to 1000 queries — stay well under
const MAX_DETAIL = 300;     // advisories detailed per pass (~40ms each, 6 wide); the rest are still recorded, undescribed
const TIMEOUT_MS = 20000;
const CONCURRENCY = 6;
const SEV = { CRITICAL: 'critical', HIGH: 'high', MODERATE: 'medium', MEDIUM: 'medium', LOW: 'low' };

/** package-lock.json (lockfile v2/v3): every installed package, exact version, dev-only flag. */
function readNpmLock(file) {
  const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = new Map();
  for (const [key, info] of Object.entries(lock.packages || {})) {
    if (!key || !info || !info.version) continue;                 // '' is the project itself
    const i = key.lastIndexOf('node_modules/');
    if (i < 0) continue;                                          // a workspace path, not an installed package
    const name = key.slice(i + 'node_modules/'.length);
    const k = `${name}@${info.version}`;
    const prev = out.get(k);
    out.set(k, { name, version: info.version, ecosystem: 'npm', dev: prev ? (prev.dev && !!info.dev) : !!info.dev });
  }
  return [...out.values()];
}

/** uv.lock (TOML): every [[package]] block's name + version; the editable project itself is skipped. */
function readUvLock(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = /^name = "([^"]+)"/m.exec(block), version = /^version = "([^"]+)"/m.exec(block);
    if (!name || !version) continue;
    if (/^source = \{[^}]*editable/m.test(block)) continue;
    out.push({ name: name[1], version: version[1], ecosystem: 'PyPI', dev: false });
  }
  return out;
}

/** The lockfiles under a root, with their readers. */
function manifestsOf(root) {
  const out = [];
  for (const [file, reader] of [['package-lock.json', readNpmLock], ['uv.lock', readUvLock]]) {
    const p = path.join(root, file);
    if (fs.existsSync(p)) out.push({ file: p, reader });
  }
  return out;
}

async function _fetchJson(fetchImpl, url, init) {
  if (!url.startsWith(`${OSV_HOST}/`)) throw new Error(`refusing a non-OSV host: ${url}`);   // the one fixed host
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetchImpl(url, { ...(init || {}), signal: ctl.signal });
    if (!r.ok) throw new Error(`OSV ${r.status} for ${url.slice(OSV_HOST.length)}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

/** Which of these exact versions carry an advisory → [{ pkg, ids }]. */
async function queryOsv(pkgs, { fetchImpl }) {
  const hits = [];
  for (let i = 0; i < pkgs.length; i += BATCH) {
    const slice = pkgs.slice(i, i + BATCH);
    const body = { queries: slice.map((p) => ({ package: { name: p.name, ecosystem: p.ecosystem }, version: p.version })) };
    const res = await _fetchJson(fetchImpl, `${OSV_HOST}/v1/querybatch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    (res.results || []).forEach((r, j) => {
      const ids = ((r && r.vulns) || []).map((v) => v && v.id).filter(Boolean);
      if (ids.length) hits.push({ pkg: slice[j], ids });
    });
  }
  return hits;
}

function _digest(v) {
  const dbsev = String(((v && v.database_specific) || {}).severity || '').toUpperCase();
  const fixed = {};
  for (const a of ((v && v.affected) || [])) {
    const name = String(((a && a.package) || {}).name || '').toLowerCase();
    for (const r of ((a && a.ranges) || [])) for (const e of ((r && r.events) || [])) if (e && e.fixed && !fixed[name]) fixed[name] = e.fixed;
  }
  const summary = (v && v.summary) || String((v && v.details) || '').split('\n')[0].slice(0, 160);
  return { summary, severity: SEV[dbsev] || 'medium', aliases: ((v && v.aliases) || []).filter((x) => /^CVE-/.test(x)).slice(0, 3), fixed, withdrawn: !!(v && v.withdrawn) };
}

/** Advisory details, bounded + concurrent → Map<id, { summary, severity, aliases, fixed, withdrawn } | { error }>. */
async function detailOsv(ids, { fetchImpl }) {
  const out = new Map();
  const want = ids.slice(0, MAX_DETAIL);
  for (let i = 0; i < want.length; i += CONCURRENCY) {
    await Promise.all(want.slice(i, i + CONCURRENCY).map(async (id) => {
      try { out.set(id, _digest(await _fetchJson(fetchImpl, `${OSV_HOST}/v1/vulns/${encodeURIComponent(id)}`))); }
      catch (e) { out.set(id, { error: (e && e.message) || String(e) }); }
    }));
  }
  return out;
}

/**
 * Scan the lockfiles under the in-scope roots. Returns { ok, packages, advisories, findings, notes, error }.
 * `deps`: fetchImpl (default the global fetch), gate (default lib/security_scope.pathInScope).
 * A dev-only npm package's advisory is capped at medium — build-time exposure, not a served surface.
 */
async function scanDeps(roots, { deps = {} } = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const gate = deps.gate || require('./security_scope').pathInScope;
  const findings = [], notes = [];
  let packages = 0, advisories = 0, error = null;
  if (typeof fetchImpl !== 'function') return { ok: false, packages, advisories, findings, notes, error: 'no fetch available' };
  const work = [];
  for (const root of (roots || [])) {
    if (!gate(root)) { notes.push(`root off-scope: ${root}`); continue; }
    for (const m of manifestsOf(root)) {
      try { const pkgs = m.reader(m.file); packages += pkgs.length; work.push({ file: m.file, pkgs }); }
      catch (e) { notes.push(`${path.basename(m.file)} unreadable: ${(e && e.message) || String(e)}`); }
    }
  }
  try {
    const perFile = [];
    const allIds = new Set();
    for (const w of work) {
      const hits = await queryOsv(w.pkgs, { fetchImpl });
      perFile.push({ file: w.file, hits });
      for (const h of hits) for (const id of h.ids) allIds.add(id);
    }
    const details = await detailOsv([...allIds], { fetchImpl });
    if (allIds.size > MAX_DETAIL) notes.push(`${allIds.size - MAX_DETAIL} advisories recorded without details (cap ${MAX_DETAIL})`);
    for (const pf of perFile) for (const h of pf.hits) for (const id of h.ids) {
      const d = details.get(id) || {};
      if (d.withdrawn) continue;
      advisories++;
      const { pkg } = h;
      let severity = d.severity || 'medium';
      if (pkg.dev && (severity === 'critical' || severity === 'high')) severity = 'medium';
      const fx = d.fixed && d.fixed[pkg.name.toLowerCase()];
      const what = d.summary || (d.error ? `details unavailable: ${d.error}` : 'details not fetched (cap)');
      findings.push({
        asset: pf.file, class: 'dependency', severity,
        title: `${id} in ${pkg.name}@${pkg.version}`,
        evidence: `${pkg.ecosystem} ${pkg.name}@${pkg.version}${pkg.dev ? ' (dev-only)' : ''} — ${what}${d.aliases && d.aliases.length ? ` [${d.aliases.join(', ')}]` : ''}`,
        proposed_fix: `${fx ? `upgrade ${pkg.name} to >= ${fx}` : `upgrade ${pkg.name} past the affected range`} — https://osv.dev/vulnerability/${id}`,
      });
    }
  } catch (e) { error = (e && e.message) || String(e); }
  return { ok: !error, packages, advisories, findings, notes, error };
}

module.exports = { scanDeps, readNpmLock, readUvLock, manifestsOf, queryOsv, detailOsv, OSV_HOST, MAX_DETAIL, BATCH };
