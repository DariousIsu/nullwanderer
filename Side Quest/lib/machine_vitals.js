/**
 * lib/machine_vitals.js — Loop C of the deterministic-loops build (2026-08-15): INTEROCEPTION for
 * the machine. The machine is her body, and until now it appeared nowhere — no live monitor, only
 * comment-fossils from the VRAM-pin postmortems. Zero LLM: python-free python-loop (this is Node's
 * side of the doctrine — deterministic sampling, model never called).
 *
 * THE BEAT CONTRACT (§0b): samples land in meta `machine_vitals`, which lib/status_vector reads as
 * its `machine` section — the data terminates in her cognition beats (awareness line + state door),
 * never in a dead dashboard. Threshold ANOMALIES escalate through obs_bus (lane 'machine') so
 * self_watch's existing repair loop finally has machine-level senses. Per-sample model calls are
 * exactly what this build removes — nothing here ever calls one.
 *
 * Cadence: main.js ticks sample() every ~60s. CPU is a delta between consecutive ticks (os.cpus()
 * cumulative times — no shelling). RAM from os. Disk via fs.statfs (Node ≥19.6; fail-absent).
 * GPU dedicated-memory via a PowerShell perf counter at a SLOWER cadence (≥5 min; ~1s shell) and
 * self-disables after repeated failure — best-effort, fail-absent, never load-bearing.
 * Anomaly emits are rate-limited (once per 30 min per type) so a bad hour can't flood the bus.
 */
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const GPU_EVERY_MS = 5 * 60e3;
const GPU_MAX_FAILS = 2;
const ANOMALY_COOLDOWN_MS = 30 * 60e3;
const CPU_HOT_PCT = 90;          // sustained (3 consecutive samples) → anomaly
const RAM_LOW_PCT = 5;           // free below this % → anomaly
const DISK_LOW_PCT = 10;         // free below this % → anomaly

// module state (per-process; a restart just re-primes)
let _prevCpu = null;             // aggregate {busy, total} from the last sample
let _cpuHotStreak = 0;
let _gpu = { at: 0, fails: 0, off: false, last: null };
const _lastAnomalyAt = {};       // type → ts

// Aggregate os.cpus() times into one {busy, total}.
function _cpuTotals(cpus) {
  let busy = 0, total = 0;
  for (const c of (cpus || [])) {
    const t = c.times || {};
    const sum = (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.idle || 0) + (t.irq || 0);
    total += sum; busy += sum - (t.idle || 0);
  }
  return { busy, total };
}

// PURE: percent busy between two aggregate samples, or null when undefined (first call / no delta).
function cpuPctBetween(prev, cur) {
  if (!prev || !cur) return null;
  const dTotal = cur.total - prev.total, dBusy = cur.busy - prev.busy;
  if (!(dTotal > 0)) return null;
  return Math.max(0, Math.min(100, Math.round((dBusy / dTotal) * 100)));
}

// Best-effort GPU dedicated-memory (bytes) via Windows perf counters. Async shell, ~1s; disabled
// after GPU_MAX_FAILS consecutive failures so a machine without the counter never keeps paying.
function _sampleGpu() {
  return new Promise((resolve) => {
    try {
      const { exec } = require('child_process');
      const cmd = `powershell -NoProfile -Command "(Get-Counter '\\GPU Adapter Memory(*)\\Dedicated Usage' -ErrorAction Stop).CounterSamples | Measure-Object -Property CookedValue -Sum | Select-Object -ExpandProperty Sum"`;
      exec(cmd, { timeout: 15000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null);
        const n = Number(String(stdout || '').trim());
        resolve(Number.isFinite(n) && n >= 0 ? n : null);
      });
    } catch { resolve(null); }
  });
}

function _emitAnomaly(type, text, { deps = {}, nowMs = Date.now() } = {}) {
  if (nowMs - (_lastAnomalyAt[type] || 0) < ANOMALY_COOLDOWN_MS) return;
  _lastAnomalyAt[type] = nowMs;
  try {
    ((deps.obsBus) || require('./obs_bus')).emit(
      { lane: 'machine', kind: 'anomaly', level: 'warn', text, ref: type },
      { deps, nowMs }
    );
  } catch {}
}

/**
 * Take one sample, persist it to meta `machine_vitals`, emit threshold anomalies. Fail-soft: any
 * section that can't be read is simply absent. Returns the sample.
 */
async function sample({ deps = {}, nowMs = Date.now(), dataDir = null } = {}) {
  const out = { at: nowMs };
  // CPU (delta since last tick)
  try {
    const cur = _cpuTotals((deps.cpus || os.cpus)());
    out.cpuPct = cpuPctBetween(_prevCpu, cur);
    _prevCpu = cur;
    if (out.cpuPct != null && out.cpuPct >= CPU_HOT_PCT) {
      _cpuHotStreak++;
      if (_cpuHotStreak >= 3) _emitAnomaly('cpu_hot', `CPU at ${out.cpuPct}% for 3+ consecutive minutes`, { deps, nowMs });
    } else _cpuHotStreak = 0;
  } catch {}
  // RAM
  try {
    const free = (deps.freemem || os.freemem)(), total = (deps.totalmem || os.totalmem)();
    out.ramFreeGB = Math.round(free / 1073741824 * 10) / 10;
    out.ramTotalGB = Math.round(total / 1073741824 * 10) / 10;
    out.ramFreePct = total > 0 ? Math.round((free / total) * 100) : null;
    if (out.ramFreePct != null && out.ramFreePct < RAM_LOW_PCT) {
      _emitAnomaly('ram_low', `RAM nearly exhausted — ${out.ramFreeGB}GB free (${out.ramFreePct}%)`, { deps, nowMs });
    }
  } catch {}
  // DISK (the data volume — where her memory lives)
  try {
    const dir = dataDir || path.join(__dirname, '..', 'data');
    const sf = deps.statfs ? await deps.statfs(dir) : await fs.promises.statfs(dir);
    const freeB = Number(sf.bavail) * Number(sf.bsize), totalB = Number(sf.blocks) * Number(sf.bsize);
    if (totalB > 0) {
      out.diskFreeGB = Math.round(freeB / 1073741824);
      out.diskFreePct = Math.round((freeB / totalB) * 100);
      if (out.diskFreePct < DISK_LOW_PCT) {
        _emitAnomaly('disk_low', `Data volume low — ${out.diskFreeGB}GB free (${out.diskFreePct}%)`, { deps, nowMs });
      }
    }
  } catch {}
  // GPU (slow cadence, best-effort, self-disabling)
  try {
    if (!_gpu.off && (nowMs - _gpu.at) >= GPU_EVERY_MS) {
      _gpu.at = nowMs;
      const bytes = deps.gpuBytes !== undefined ? deps.gpuBytes : await _sampleGpu();
      if (bytes == null) {
        _gpu.fails++;
        if (_gpu.fails >= GPU_MAX_FAILS) { _gpu.off = true; }
      } else { _gpu.fails = 0; _gpu.last = { at: nowMs, usedGB: Math.round(bytes / 1073741824 * 10) / 10 }; }
    }
    if (_gpu.last) out.gpu = _gpu.last;
  } catch {}
  out.uptimeMin = Math.round(((deps.uptime || (() => process.uptime()))()) / 60);
  try { ((deps.db) || require('./db')).setMeta('machine_vitals', JSON.stringify(out)); } catch {}
  return out;
}

// One compact phrase for the status vector's machine section. Null when nothing sampled.
function describe(v) {
  if (!v || !v.at) return null;
  const bits = [];
  if (v.cpuPct != null) bits.push(`CPU ${v.cpuPct}%`);
  if (v.ramFreeGB != null) bits.push(`RAM ${v.ramFreeGB}GB free`);
  if (v.diskFreeGB != null) bits.push(`disk ${v.diskFreeGB}GB free${v.diskFreePct != null ? ` (${v.diskFreePct}%)` : ''}`);
  if (v.gpu && v.gpu.usedGB != null) bits.push(`GPU ${v.gpu.usedGB}GB used`);
  return bits.length ? bits.join(' · ') : null;
}

module.exports = { sample, describe, cpuPctBetween, _sampleGpu, CPU_HOT_PCT, RAM_LOW_PCT, DISK_LOW_PCT, ANOMALY_COOLDOWN_MS };
