/**
 * lib/kg_activity.js — the Side Quest emit surface for the kg:activity bus (Slice 2).
 *
 * The DB-side emitters (graph_memory writes now; recall/promote/doc lanes later) call emit() to push a real
 * data-interaction event to the KG panel's shipped Stage-A gesture kit. Bridges to main.js's broadcaster
 * (global.__emitKgActivity, installed in Slice 1). Safe-with-no-receiver: if main hasn't installed it — a
 * smoke test, a headless ELECTRON_RUN_AS_NODE run, or before boot — this is a silent no-op, and it NEVER
 * throws into the hot DB write path (the dedup rule: payloads are tiny, additive, and side-effect-free).
 */
function emit(payload) {
  try {
    if (!payload || !payload.kind) return;
    const f = global.__emitKgActivity;
    if (typeof f === 'function') f(payload);
  } catch (e) { /* never disturb the caller's DB write */ }
}

module.exports = { emit };
