/**
 * child_env — the environment Zoe hands to the Echo processes she spawns.
 *
 * Zoe's `.env` and Echo's model-slot config share variable NAMES. Echo reads
 * SAGA_MODEL / AGENT_MODEL_SCHEDULED_BACKGROUND / AGENT_MODEL_ON_DEMAND_BACKGROUND to decide which
 * models its agent fleet runs on (echo/saga/model_slots.py). Zoe sets those same names in its own
 * .env for its own cloud fallbacks — and every Echo process Zoe launches inherits `process.env`.
 *
 * Net effect before this existed: Echo's fleet defaults (gpt-oss:120b / kimi-k2:1t /
 * deepseek-v3.1:671b) were silently overwritten by Zoe's single value on every Zoe-owned launch, so
 * all three concurrency slots ran the SAME mid-size model. Nothing errored; the fleet just quietly
 * stopped being a fleet. An adopted (externally-started) Echo was unaffected, which is why it looked
 * intermittent.
 *
 * Fix is one-directional and deliberately narrow: Zoe keeps its own vars (several call sites read
 * AGENT_MODEL_ON_DEMAND_BACKGROUND as a cloud-model fallback), and simply stops FORWARDING the
 * model-pinning ones to the child. Echo then resolves its own config, as it would if the operator
 * had started it. Everything else in the environment — paths, tokens, feature flags — passes
 * through untouched.
 *
 * Escape hatch: ZOE_ECHO_MODEL_PASSTHROUGH=1 restores the old behaviour for a deliberate pin.
 */
'use strict';

// Exactly the names echo/saga/model_slots.py reads (including the pre-β.1 aliases it still honors).
// Kept as a literal list rather than a prefix match: a prefix would also swallow unrelated
// AGENT_MODEL_* names Echo may add later, and silently un-setting a variable is the failure mode
// this module exists to fix.
const MODEL_PIN_KEYS = [
  'SAGA_MODEL',
  'AGENT_MODEL_SCHEDULED_BACKGROUND',
  'AGENT_MODEL_ON_DEMAND_BACKGROUND',
  'AGENT_MODEL_PLANNING',      // legacy alias → scheduled_background
  'AGENT_MODEL_LONG_CONTEXT',  // legacy alias → on_demand_background
];

/**
 * The environment for a spawned Echo process: `base` minus Zoe's model pins.
 * Pure (returns a new object; never mutates `base`) so it's testable offline.
 */
function forEcho(base = process.env, { passthrough = null } = {}) {
  const src = base || {};
  const allow = passthrough === null
    ? String(src.ZOE_ECHO_MODEL_PASSTHROUGH || '') === '1'
    : !!passthrough;
  const out = { ...src };
  _addFsRoots(out);
  _addAppQuotaDoor(out);
  if (allow) return out;
  const stripped = [];
  for (const k of MODEL_PIN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(out, k)) { delete out[k]; stripped.push(k); }
  }
  if (stripped.length) console.log(`[child_env] not forwarding Zoe's model pins to Echo (${stripped.join(', ')}) — Echo resolves its own fleet`);
  return out;
}

// NX_ECHO_FS_ROOTS — widen Echo's fs_read_file scope to Zoe's SOURCE dirs (O5 review fan-out:
// shard delegates read lib/ files by path). SOURCE ONLY — lib/scripts/docs — never the app root:
// data/ (her DB) and .env (credentials) must stay outside every Echo-readable root. Operator-set
// roots are kept; ours are unioned in (fs_edit.py dedups on its side too).
function _addFsRoots(out) {
  try {
    const path = require('path');
    const sqRoot = path.join(__dirname, '..');
    const ours = ['lib', 'scripts', 'docs'].map((d) => path.resolve(sqRoot, d));
    const existing = String(out.NX_ECHO_FS_ROOTS || '').split(path.delimiter).map((s) => s.trim()).filter(Boolean);
    const seen = new Set(existing.map((s) => s.toLowerCase()));
    for (const r of ours) if (!seen.has(r.toLowerCase())) existing.push(r);
    out.NX_ECHO_FS_ROOTS = existing.join(path.delimiter);
  } catch { /* env stays as-is — Echo just keeps its own repo scope */ }
}

// NX_ECHO_APP_QUOTA_URL — THE ONE PACING LAW's read door (unification stage 4, 09-02). Every Echo
// child the app spawns learns where the app's quota gate answers (GET /quota?lane=… on the loopback
// control port), so Echo's governor paces its background classes against the REAL pool instead of
// its own made-up daily budget. Only the app sets this: a hand-run or a unit test has no door and
// consults nothing. An operator-set value is kept.
function _addAppQuotaDoor(out) {
  try {
    if (String(out.NX_ECHO_APP_QUOTA_URL || '').trim()) return;
    const port = parseInt(out.ZOE_TEST_PORT, 10) || 8767;
    out.NX_ECHO_APP_QUOTA_URL = `http://127.0.0.1:${port}/quota`;
  } catch { /* env stays as-is — Echo keeps its local law */ }
}

module.exports = { forEcho, MODEL_PIN_KEYS };
