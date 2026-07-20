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
  if (allow) return out;
  const stripped = [];
  for (const k of MODEL_PIN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(out, k)) { delete out[k]; stripped.push(k); }
  }
  if (stripped.length) console.log(`[child_env] not forwarding Zoe's model pins to Echo (${stripped.join(', ')}) — Echo resolves its own fleet`);
  return out;
}

module.exports = { forEcho, MODEL_PIN_KEYS };
