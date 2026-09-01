/**
 * studio/render_arbiter.js — ONE heavy ComfyUI tenant at a time.
 *
 * The box can't hold the image model (:8188) and the video model (:8288) resident together — that IS the
 * WAVE 6/10 memory overrun: block-swap offloads a 14B model into the 31GB RAM, and two of them plus the
 * app tip the machine into the pagefile. His rule: "we don't have enough hardware to make pictures and
 * movies at the same time."
 *
 * So before EITHER instance loads its model for a job, free the OTHER instance's models. The active task's
 * model then has the machine to itself; the trade is a light warm-up reload when you switch tasks — his
 * accepted cost. Fail-soft: an unreachable instance, or an older build without POST /free, just means no
 * reclaim (never a thrown error) — the caller proceeds.
 */
'use strict';

// The two heavy instances, read from the SAME env vars the clients use so an overridden port stays in sync
// (image_client → ZOE_IMG_COMFY_URL :8188; comfy_client → ZOE_COMFY_URL :8288).
const INSTANCES = {
  image: process.env.ZOE_IMG_COMFY_URL || 'http://127.0.0.1:8188',
  video: process.env.ZOE_COMFY_URL || 'http://127.0.0.1:8288',
};

// Ask a ComfyUI instance to unload its models and release cached VRAM/RAM. Returns whether it acked.
async function freeInstance(url) {
  try {
    const r = await fetch(url + '/free', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: AbortSignal.timeout(8000),
    });
    return r.ok;
  } catch { return false; }
}

// Claim the GPU for `tenant` ('image' | 'video'): evict the OTHER tenant's models first. A model in the
// middle of a running prompt is NOT force-unloaded (ComfyUI frees only idle models), so this is safe to
// call even while the other instance is finishing something — it reclaims once that prompt completes.
async function claimGpu(tenant) {
  const other = tenant === 'image' ? 'video' : 'image';
  const freedOther = await freeInstance(INSTANCES[other]);
  return { ok: true, tenant, freedOther };
}

module.exports = { claimGpu, freeInstance, INSTANCES };
