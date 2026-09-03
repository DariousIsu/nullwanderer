/**
 * memory_map — THE ONE MEMORY MAP: both halves (Echo's `nx-echo memory-map`, Side Quest's
 * lib/memory_tiers) merged into one document that answers "what tier is this?" for every table the
 * program holds, names the promotion bridges and their measured backlog, and carries the drift
 * warnings from both sides. Stage 3 of the unification (2026-09-02).
 *
 * refresh() renders the Side Quest half in-process, asks Echo for its half (an async spawn of
 * `python -m echo.main memory-map --json`, read-only, seconds), merges, and stores the map in meta
 * `memory.map` for the status vector. Pure assemble()/describe() are exported for the smoke.
 */
'use strict';
const { spawn } = require('child_process');

const META_KEY = 'memory.map';
const SHORT = 'short-term';
const LONG = 'long-term';

function _dbm(deps) { return (deps && deps.db) || require('./db'); }

// Merge the two halves. Either may be absent (then the map says so — measured-never-asserted).
function assemble({ echo = null, sq = null, nowMs = Date.now() } = {}) {
  const tiers = { [SHORT]: { tables: 0, stores: [] }, [LONG]: { tables: 0, stores: [] } };
  const warnings = [], bridges = [];
  const continuity = { dead_ends: [], stalled: [] };
  const unmapped = [], phantoms = [], clocks = {};
  const halves = { echo: !!(echo && echo.tiers), sq: !!(sq && sq.tiers) };
  for (const [side, half] of [['sq', sq], ['echo', echo]]) {
    if (!half || !half.tiers) { warnings.push(`${side} half unavailable${half && half.error ? `: ${half.error}` : ''}`); continue; }
    for (const tier of [SHORT, LONG]) {
      const t = half.tiers[tier] || {};
      tiers[tier].tables += t.tables || 0;
      for (const s of (t.stores || [])) tiers[tier].stores.push(`${side}.${s}`);
    }
    for (const b of (half.bridges || [])) bridges.push({ ...b, side });
    for (const w of (half.warnings || [])) warnings.push(`${side}: ${w}`);
    const c = half.continuity || {};
    for (const d of (c.dead_ends || [])) continuity.dead_ends.push({ ...d, side });
    for (const s of (c.stalled || [])) continuity.stalled.push({ ...s, side });
    for (const u of (half.unmapped || [])) unmapped.push({ ...u, side });
    for (const p of (half.phantoms || [])) phantoms.push({ ...p, side });
    for (const [a, clk] of Object.entries(half.clocks || {})) clocks[`${side}.${a}`] = clk;
  }
  const backlog = bridges.reduce((n, b) => n + (Number.isInteger(b.pending) ? b.pending : 0), 0);
  return {
    memory_map_version: 2, at: nowMs, halves, tiers, bridges, backlog,
    cross_file_staging: (echo && echo.cross_file_staging) || [],
    continuity, unmapped, phantoms, clocks,
    warnings,
  };
}

function _n(x) { return Number.isInteger(x) ? x.toLocaleString('en-US') : (x == null ? '?' : String(x)); }

// The one-liner (rides the status line) and the block (behind the state door).
function describe(map) {
  if (!map || !map.tiers) return { line: null, block: [] };
  const st = map.tiers[SHORT], lt = map.tiers[LONG];
  const warn = (map.warnings || []).length;
  const halves = map.halves || {};
  const partial = (!halves.echo || !halves.sq) ? ` (${!halves.echo ? 'Echo half missing' : 'Side Quest half missing'})` : '';
  const cont = map.continuity || { dead_ends: [], stalled: [] };
  const nDead = (cont.dead_ends || []).length, nStall = (cont.stalled || []).length, nOut = (map.unmapped || []).length;
  const contBit = (nDead || nStall) ? ` · continuity: ${nDead} dead end(s), ${nStall} stalled bridge(s)` : '';
  const line = `one memory: ${_n(st.tables)} short-term / ${_n(lt.tables)} long-term tables · promotion backlog ${_n(map.backlog)} rows${contBit}${nOut ? ` · ${nOut} store(s) outside the map` : ''}${warn ? ` · ${warn} tier warning(s)` : ''}${partial}`;
  const block = [];
  block.push(`One memory, two tiers${partial}: short-term ${_n(st.tables)} tables across ${st.stores.length} store(s) · long-term ${_n(lt.tables)} tables across ${lt.stores.length} store(s).`);
  const bs = [...(map.bridges || [])].sort((a, b) => (Number.isInteger(b.pending) ? b.pending : -1) - (Number.isInteger(a.pending) ? a.pending : -1));
  if (bs.length) {
    block.push(`Promotion bridges (backlog ${_n(map.backlog)} rows waiting on a gate): ${bs.slice(0, 8).map((b) => `${b.from} → ${b.to}: ${b.pending == null ? (b.measure != null ? `${_n(b.measure)} linked` : '?') : `${_n(b.pending)} pending`}${b.stalled ? ' (STALLED)' : ''}${b.built === false ? ' (DEAD END)' : ''}`).join(' · ')}.`);
  }
  if (nDead || nStall) {
    const parts = [];
    for (const d of cont.dead_ends) parts.push(`DEAD END ${d.from} (${_n(d.pending)} rows, ${d.why})`);
    for (const s of cont.stalled) parts.push(`STALLED ${s.from} (${_n(s.pending)} pending, ${s.why})`);
    block.push(`Continuity — memory that enters and never leaves: ${parts.join(' · ')}.`);
  } else block.push('Continuity: every bridge has a built gate that has fired within the stall window.');
  if (nOut || (map.phantoms || []).length) {
    const parts = [...(map.unmapped || []).map((u) => `${u.side}:${u.path} (${u.size_mb} MB, unmapped)`), ...(map.phantoms || []).map((p) => `${p.side}:${p.path} (phantom — ${p.note})`)];
    block.push(`Outside the map: ${parts.join(' · ')}.`);
  }
  if (map.cross_file_staging && map.cross_file_staging.length) {
    block.push(`Short-term staging living inside a long-term file: ${map.cross_file_staging.map((c) => `${c.store}.${c.table} (${_n(c.rows)})`).join(' · ')}.`);
  }
  if (warn) block.push(`Tier warnings (${warn}): ${map.warnings.slice(0, 5).join(' · ')}${warn > 5 ? ' …' : ''}.`);
  else block.push('Tier warnings: none — every table on both sides has a declared tier.');
  return { line, block };
}

// Echo's half: `python -m echo.main memory-map --json`. Read-only, seconds. Never throws — a failure
// becomes { error } so the map can say "Echo half unavailable".
function readEchoMap({ python, cwd, timeoutMs = 120000, spawnFn = spawn, counts = true } = {}) {
  return new Promise((resolve) => {
    if (!python || !cwd) return resolve({ error: 'no python/cwd for Echo' });
    let out = '', err = '', done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(tm); resolve(v); };
    let proc;
    const args = ['-m', 'echo.main', 'memory-map', '--json'];
    if (!counts) args.push('--no-counts');
    try { proc = spawnFn(python, args, { cwd, env: require('./child_env').forEcho(process.env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch (e) { return resolve({ error: e.message }); }
    const tm = setTimeout(() => { try { proc.kill(); } catch {} finish({ error: `timed out after ${timeoutMs}ms` }); }, timeoutMs);
    try { if (proc.stdout) proc.stdout.on('data', (d) => { out += String(d); }); } catch {}
    try { if (proc.stderr) proc.stderr.on('data', (d) => { err += String(d); }); } catch {}
    proc.on('error', (e) => finish({ error: e.message }));
    proc.on('exit', (code) => {
      if (code !== 0) return finish({ error: `exit ${code}: ${err.trim().slice(0, 200)}` });
      try { finish(JSON.parse(out)); } catch (e) { finish({ error: `unreadable: ${e.message}` }); }
    });
  });
}

async function refresh({ deps = {}, nowMs = Date.now() } = {}) {
  const tiersLib = deps.tiers || require('./memory_tiers');
  let sq = null;
  try { sq = tiersLib.render({ counts: deps.counts !== false, nowMs }); } catch (e) { sq = { error: e.message }; }
  const echo = deps.echoMap || await readEchoMap({ python: deps.python, cwd: deps.cwd, spawnFn: deps.spawnFn, counts: deps.counts !== false });
  const map = assemble({ echo, sq, nowMs });
  try { _dbm(deps).setMeta(META_KEY, JSON.stringify(map)); } catch {}
  return map;
}

function stored(deps = {}) {
  try { const m = JSON.parse(_dbm(deps).getMeta(META_KEY) || 'null'); return (m && m.at) ? m : null; } catch { return null; }
}

module.exports = { assemble, describe, readEchoMap, refresh, stored, META_KEY, SHORT, LONG };
