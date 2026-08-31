/**
 * studio/image_client.js — text-to-image via the local ComfyUI SDXL (same server as the video takes).
 *
 * Schema-validated API graph (SDXL base: checkpoint → CLIP encode ×2 → KSampler → VAE decode → save),
 * submit /prompt, poll /history, return the produced PNG path. Fail-soft { ok:false } throughout.
 *
 * This is the generation engine under the image suite: persona/scenery/scene creators all build a prompt
 * and call generate(). 1024×1024 (or a chosen aspect) on the 7900 XT. The video takes' resolver pattern.
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

const NEG = 'lowres, worst quality, low quality, jpeg artifacts, blurry, deformed, disfigured, bad anatomy, extra limbs, extra fingers, fused fingers, mutated hands, poorly drawn face, watermark, signature, text, cropped, out of frame';

// aspect → SDXL-friendly latent size (multiples of 8; ~1MP)
const SIZES = { square: [1024, 1024], portrait: [832, 1216], vertical: [768, 1344], landscape: [1216, 832] };

// stage a reference image into ComfyUI's input dir (LoadImage reads by basename); returns the basename
function stageInput(file) {
  const dst = path.join(COMFY_ROOT, 'input', path.basename(file));
  fs.copyFileSync(file, dst);
  return path.basename(file);
}

async function buildGraph({ prompt, negative, aspect = 'portrait', steps = 28, cfg = 6.5, seed, prefix = 'img', references = [], ipWeight = 0.8 }) {
  const OI = await objectInfo();
  const graph = {}; let n = 0;
  const node = (cls, inputs) => {
    const spec = OI[cls] && OI[cls].input;
    if (!spec) throw new Error(`unknown node ${cls}`);
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
  const [W, H] = SIZES[aspect] || SIZES.portrait;
  const ckptEnum = OI.CheckpointLoaderSimple.input.required.ckpt_name[0];
  const ckpt = ckptEnum.find(c => /sd_xl_base/i.test(c)) || ckptEnum[0];
  const sampEnum = OI.KSampler.input.required.sampler_name[0];
  const sampler = ['dpmpp_2m', 'euler', 'dpmpp_2m_sde'].find(s => sampEnum.includes(s)) || sampEnum[0];
  const schedEnum = OI.KSampler.input.required.scheduler[0];
  const scheduler = ['karras', 'normal'].find(s => schedEnum.includes(s)) || schedEnum[0];

  const model = node('CheckpointLoaderSimple', { ckpt_name: ckpt });
  const pos = node('CLIPTextEncode', { text: String(prompt || ''), clip: out(model, 1) });
  const neg = node('CLIPTextEncode', { text: String(negative || NEG), clip: out(model, 1) });
  const lat = node('EmptyLatentImage', { width: W, height: H, batch_size: 1 });

  // IDENTITY LOCK: when reference image(s) are given (a selected avatar), IPAdapter conditions SDXL on
  // them so the generated person keeps that face AND body. MULTIPLE references (the avatar's whole growing
  // set — every added video frame / photo) are batched and AVERAGED, so more material = a stronger,
  // more consistent identity across every resulting image (and the frames it seeds for video).
  let sampModel = out(model, 0);
  const refs = (Array.isArray(references) ? references : []).filter(Boolean);
  if (refs.length) {
    const ipa = node('IPAdapterModelLoader', { ipadapter_file: OI.IPAdapterModelLoader.input.required.ipadapter_file[0][0] });
    const cvEnum = OI.CLIPVisionLoader.input.required.clip_name[0];
    const cv = node('CLIPVisionLoader', { clip_name: cvEnum.find(c => /clip_vision_h/i.test(c)) || cvEnum[0] });
    // load + batch every reference
    let img = null;
    for (const r of refs) {
      const li = node('LoadImage', { image: r });
      img = img === null ? out(li) : (() => { const b = node('ImageBatch', { image1: img, image2: out(li) }); return out(b); })();
    }
    const ceEnum = OI.IPAdapterAdvanced.input.required.combine_embeds[0];
    const combine = ceEnum.includes('average') ? 'average' : ceEnum[0];
    const wtEnum = OI.IPAdapterAdvanced.input.required.weight_type[0];
    const wtype = wtEnum.includes('linear') ? 'linear' : wtEnum[0];
    const esEnum = OI.IPAdapterAdvanced.input.required.embeds_scaling[0];
    const ipAdv = node('IPAdapterAdvanced', {
      model: out(model, 0), ipadapter: out(ipa), image: img, clip_vision: out(cv),
      weight: ipWeight, weight_type: wtype, combine_embeds: combine,
      start_at: 0.0, end_at: 1.0, embeds_scaling: esEnum[0],
    });
    sampModel = out(ipAdv);
  }

  const samp = node('KSampler', {
    model: sampModel, positive: out(pos), negative: out(neg), latent_image: out(lat),
    seed: Number.isFinite(seed) ? seed : ((Date.now() % 2147483647)), steps, cfg,
    sampler_name: sampler, scheduler, denoise: 1.0,
  });
  const dec = node('VAEDecode', { samples: out(samp), vae: out(model, 2) });
  node('SaveImage', { images: out(dec), filename_prefix: prefix });
  return graph;
}

async function generate(opts) {
  try {
    if (!(await alive())) return { ok: false, error: 'ComfyUI not reachable' };
    const o = Object.assign({}, opts);
    // stage reference images (absolute paths) into ComfyUI's input dir → basenames for LoadImage
    if (Array.isArray(o.references) && o.references.length) {
      o.references = o.references.filter(p => p && fs.existsSync(p)).slice(0, 5).map(stageInput);
    }
    const graph = await buildGraph(o);
    const r = await fetch(BASE + '/prompt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: graph }), signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) return { ok: false, error: `submit HTTP ${r.status}: ${(await r.text()).slice(0, 400)}` };
    const pid = (await r.json()).prompt_id;
    // poll for the saved image
    const deadline = Date.now() + (opts.timeoutMs || 300000);
    while (Date.now() < deadline) {
      await new Promise(res => setTimeout(res, 3000));
      let h;
      try { h = await (await fetch(`${BASE}/history/${pid}`, { signal: AbortSignal.timeout(15000) })).json(); }
      catch { continue; }
      if (!h[pid]) continue;
      const st = h[pid].status || {};
      if (st.status_str === 'error') {
        const m = (st.messages || []).find(x => x[0] === 'execution_error');
        return { ok: false, error: m ? `${m[1].node_type}: ${String(m[1].exception_message || '').slice(0, 400)}` : 'render error' };
      }
      for (const o of Object.values(h[pid].outputs || {}))
        for (const img of (o.images || []))
          return { ok: true, promptId: pid, file: path.join(COMFY_ROOT, 'output', img.subfolder || '', img.filename) };
    }
    return { ok: false, error: 'timed out waiting for image' };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

module.exports = { generate, alive, SIZES, BASE, COMFY_ROOT };
