/**
 * studio/comfy_client.js — node client for the local ComfyUI (ROCm) render server.
 *
 * Wraps the proven headless pattern from the InfiniteTalk gate: build a schema-validated API graph
 * (every input name and enum checked against /object_info BEFORE submission, so wiring mistakes fail
 * in milliseconds, not twenty minutes into a render), POST /prompt, poll /history.
 *
 * Fail-soft: every export resolves { ok:false, error } on a dead server / bad graph / failed render.
 */
'use strict';
const path = require('path');
const fs = require('fs');

const BASE = process.env.ZOE_COMFY_URL || 'http://127.0.0.1:8288';
const COMFY_ROOT = process.env.ZOE_COMFY_ROOT || 'C:\\Users\\azrae\\Desktop\\ComfyUI-Zluda';

let _oi = null, _oiTs = 0;
async function objectInfo() {
  if (_oi && Date.now() - _oiTs < 10 * 60 * 1000) return _oi;
  const r = await fetch(BASE + '/object_info', { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`object_info HTTP ${r.status}`);
  _oi = await r.json(); _oiTs = Date.now();
  return _oi;
}

async function alive() {
  try { const r = await fetch(BASE + '/queue', { signal: AbortSignal.timeout(4000) }); return r.ok; }
  catch { return false; }
}

// Copy an input file into ComfyUI's input dir (LoadImage/LoadAudio read from there by basename).
function stageInput(file) {
  const dst = path.join(COMFY_ROOT, 'input', path.basename(file));
  fs.copyFileSync(file, dst);
  return path.basename(file);
}

const NEG = 'bright tones, overexposed, static, blurred details, subtitles, style, works, painting, image, still, overall gray, worst quality, low quality, JPEG compression residue, ugly, incomplete, extra fingers, poorly drawn hands, poorly drawn faces, deformed, disfigured, misshapen limbs, fused fingers, still picture, messy background, three legs, many people in the background, walking backwards';

// Smallest-first preference for the Wan2.1 i2v base — lower quant = less RAM under block-swap, which
// is what lets the render share the machine with the program. Picks the first present in ComfyUI's
// model list; an explicit override (env/opts) wins if that file is actually available.
const BASE_PREF = ['Q3_K_S', 'Q3_K_M', 'Q4_K_S', 'Q4_0', 'Q4_1', 'Q4_K_M', 'Q5_K_S', 'Q5_0', 'Q5_K_M', 'Q6_K', 'Q8_0', 'BF16', 'F16'];
function resolveBaseModel(OI, override) {
  const avail = (OI.WanVideoModelLoader && OI.WanVideoModelLoader.input.required.model[0]) || [];
  const bases = avail.filter(m => /wan2\.1-i2v-14b-480p/i.test(m));
  if (override && bases.includes(override)) return override;
  for (const q of BASE_PREF) { const hit = bases.find(m => m.toUpperCase().includes(q)); if (hit) return hit; }
  return bases[0] || 'wan2.1-i2v-14b-480p-Q4_K_M.gguf';
}

/*
 * buildTakeGraph — the InfiniteTalk I2V take, parameterized: reference image, driving WAV, its
 * duration, an output prefix, and the performance direction. Steps default to 4 (the lightx2v
 * distill's native operating point); frames are capped to the audio so nothing renders padding.
 */
async function buildTakeGraph({ image, audio, durSec, prefix, prompt, steps = 4, seed = 7, baseModel = null }) {
  const OI = await objectInfo();
  const graph = {}; let n = 0;
  const node = (cls, inputs) => {
    const spec = OI[cls] && OI[cls].input;
    if (!spec) throw new Error(`unknown node class ${cls}`);
    const allowed = new Set([...Object.keys(spec.required || {}), ...Object.keys(spec.optional || {})]);
    for (const [k, v] of Object.entries(inputs)) {
      if (!allowed.has(k)) throw new Error(`bad input ${cls}.${k}`);
      const def = (spec.required || {})[k] || (spec.optional || {})[k];
      if (Array.isArray(def[0]) && !Array.isArray(v) && !def[0].includes(v)) throw new Error(`bad enum ${cls}.${k}=${v}`);
    }
    graph[String(++n)] = { class_type: cls, inputs };
    return String(n);
  };
  const out = (id, i = 0) => [id, i];
  const mtKey = Object.keys(OI.WanVideoSampler.input.optional).find(k => k.toLowerCase().includes('multitalk'));
  const frames = Math.ceil(durSec * 25) + 1;

  // RIGHT-SIZE THE RENDERER: on a 20GB GPU + 31GB RAM, block-swap offloads the base model to RAM,
  // so a smaller quant is what lets the render coexist with the rest of the program instead of
  // thrashing the pagefile. Prefer the SMALLEST available i2v base (Q3 ≈ 8GB fits; Q4 ≈ 10.6GB tips
  // it into paging). Auto-picks whatever is on disk today (Q4) and upgrades to Q3 the moment it lands
  // — no code change needed. Override with ZOE_WAN_BASE.
  const resolvedBase = resolveBaseModel(OI, baseModel || process.env.ZOE_WAN_BASE);

  // blocks_to_swap = how many of the 40 transformer blocks to OFFLOAD to RAM (higher = more RAM, less
  // VRAM). On 31GB RAM the RAM is the tighter resource, so a SHORT 1-window take can afford to keep more
  // blocks in the 20GB VRAM — LOWER this to relieve RAM (risk: too low overflows VRAM). Env-tunable; the
  // default stays 20 (the known VRAM-safe value) so the committed code never regresses.
  const blockSwap = parseInt(process.env.ZOE_WAN_BLOCK_SWAP, 10) || 20;
  const swap = node('WanVideoBlockSwap', { blocks_to_swap: blockSwap, offload_img_emb: false, offload_txt_emb: false });
  const lora = node('WanVideoLoraSelect', { lora: 'lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors', strength: 1.0, low_mem_load: false, merge_loras: false });
  const mtalk = node('MultiTalkModelLoader', { model: 'Wan2_1-InfiniteTalk_Single_Q8.gguf' });
  const model = node('WanVideoModelLoader', { model: resolvedBase, base_precision: 'fp16_fast', quantization: 'disabled', load_device: 'offload_device', attention_mode: 'sdpa', block_swap_args: out(swap), lora: out(lora), multitalk_model: out(mtalk) });
  const vae = node('WanVideoVAELoader', { model_name: 'Wan2_1_VAE_bf16.safetensors', precision: 'bf16' });
  const clipv = node('CLIPVisionLoader', { clip_name: 'clip_vision_h.safetensors' });
  const img = node('LoadImage', { image });
  const rsz = node('ImageResizeKJv2', { image: out(img), width: 480, height: 832, upscale_method: 'lanczos', keep_proportion: 'crop', pad_color: '0, 0, 0', crop_position: 'center', divisible_by: 16 });
  const cve = node('WanVideoClipVisionEncode', { clip_vision: out(clipv), image_1: out(rsz), strength_1: 1.0, strength_2: 1.0, crop: 'center', combine_embeds: 'average', force_offload: true });
  const aud = node('LoadAudio', { audio });
  const w2v = node('DownloadAndLoadWav2VecModel', { model: 'TencentGameMate/chinese-wav2vec2-base', base_precision: 'fp16', load_device: 'main_device' });
  const emb = node('MultiTalkWav2VecEmbeds', { wav2vec_model: out(w2v), audio_1: out(aud), normalize_loudness: true, num_frames: frames, fps: 25.0, audio_scale: 1.0, audio_cfg_scale: 1.0, multi_audio_type: 'para' });
  const text = node('WanVideoTextEncodeCached', { model_name: 'umt5-xxl-enc-fp8_e4m3fn.safetensors', precision: 'bf16', positive_prompt: prompt, negative_prompt: NEG, quantization: 'fp8_e4m3fn', use_disk_cache: true, device: 'gpu' });
  const i2v = node('WanVideoImageToVideoMultiTalk', { vae: out(vae), width: 480, height: 832, frame_window_size: 81, motion_frame: 9, force_offload: false, colormatch: 'disabled', start_image: out(rsz), clip_embeds: out(cve), mode: 'infinitetalk' });
  const samp = node('WanVideoSampler', { model: out(model), image_embeds: out(i2v), steps, cfg: 1.0, shift: 11.0, seed, force_offload: true, scheduler: 'dpm++_sde', riflex_freq_index: 0, text_embeds: out(text), [mtKey]: out(emb) });
  const dec = node('WanVideoDecode', { vae: out(vae), samples: out(samp), enable_vae_tiling: true, tile_x: 272, tile_y: 272, tile_stride_x: 144, tile_stride_y: 128 });
  node('VHS_VideoCombine', { images: out(dec), frame_rate: 25.0, loop_count: 0, filename_prefix: prefix, format: 'video/h264-mp4', pingpong: false, save_output: true, audio: out(aud) });
  return graph;
}

async function submitTake(opts) {
  try {
    const graph = await buildTakeGraph(opts);
    const r = await fetch(BASE + '/prompt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: graph }), signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) return { ok: false, error: `submit HTTP ${r.status}: ${(await r.text()).slice(0, 500)}` };
    const j = await r.json();
    return { ok: true, promptId: j.prompt_id };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

// One poll: running | done (with output file path) | error (with the node's message)
async function checkTake(promptId) {
  try {
    const r = await fetch(`${BASE}/history/${promptId}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return { ok: false, error: `history HTTP ${r.status}` };
    const h = await r.json();
    if (!h[promptId]) return { ok: true, state: 'running' };
    const st = (h[promptId].status || {});
    if (st.status_str === 'error') {
      const msg = (st.messages || []).find(m => m[0] === 'execution_error');
      return { ok: true, state: 'error', error: msg ? `${msg[1].node_type}: ${String(msg[1].exception_message || '').slice(0, 600)}` : 'unknown node error' };
    }
    for (const o of Object.values(h[promptId].outputs || {}))
      for (const v of (o.gifs || []))
        return { ok: true, state: 'done', file: path.join(COMFY_ROOT, 'output', v.subfolder || '', v.filename) };
    return { ok: true, state: 'running' };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

module.exports = { alive, stageInput, submitTake, checkTake, BASE };
