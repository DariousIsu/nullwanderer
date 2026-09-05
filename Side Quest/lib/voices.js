/**
 * lib/voices.js — the voice REGISTRY: single source of truth for "which voice speaks."
 *
 * PURPOSE (voice-cloning-suite Phase 1 — the foundation every later phase builds on): one small,
 * pure-ish module that knows every voice Zoe can speak in — Kokoro style-vector BLENDS (her identity),
 * Piper STOCK models (.onnx), and (later phases) F5 CLONES — and resolves a caller's request into a
 * concrete synth descriptor `{ engine, params, license, ... }` for lib/tts.js to hand a sidecar.
 *
 * WHY A REGISTRY: today the live voice is a single baked file (data/voices/zoe_voice.json) read directly
 * by the Kokoro sidecar, and Piper's model is a lone ZOE_TTS_VOICE path. That doesn't scale to "many named
 * voices, per-surface routing, clones with consent records." The registry is that scale seam: entries are
 * data, resolution precedence is one function, and adding a voice never touches the synth path again.
 *
 * SOURCE OF TRUTH: data/voices/registry.json (co-located with the blobs it references; runtime/personal
 * state, so it lives under the gitignored data/ tree next to zoe_voice.json). On first load, if it's absent
 * we MIGRATE the current world into it — mint `zoe` from zoe_voice.json + one `stock` entry per .onnx in
 * data/voices/ — and persist. Blobs (samples, .onnx, clone cond.pt/ref.wav) stay out of git.
 *
 * FAIL-SOFT like lib/tts.js / lib/config.js: an unreadable dir, a corrupt file, a missing recipe — none
 * throw. load() falls back to an empty-but-valid registry and resolve() returns null, which the TTS layer
 * already treats as "not configured" (silence, no crash). Writes return { ok, error } and never throw.
 *
 * FACTORY + SINGLETON (mirrors createPiperService in lib/tts.js): createRegistry({ dir }) binds the API to
 * a base dir (tests point it at a temp dir); the module-level functions are a lazy singleton bound to the
 * real data/voices. Nothing here spawns a process or touches the GPU — it's config resolution only.
 */
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DIR = path.join(ROOT, 'data', 'voices');
const REGISTRY_BASENAME = 'registry.json';
const ZOE_RECIPE_BASENAME = 'zoe_voice.json';
const SURFACES = ['companion', 'meeting', 'read-aloud', 'two-way'];   // known speech surfaces (Phase 8 routes per-surface)

// pure: is this a legacy Piper model path (today's ZOE_TTS_VOICE / main.js call) rather than a registry id?
function isOnnxPath(s) { return typeof s === 'string' && /\.onnx$/i.test(s.trim()); }

// pure: read+parse JSON, fail-soft to null (missing file, bad JSON, unreadable — never throws).
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// pure: filename stem → a human label. en_US-lessac-medium → "Lessac (en_US, medium)". Fallback = the stem.
function prettyName(stem) {
  try {
    const parts = String(stem).split('-');
    if (parts.length >= 2) {
      const locale = parts[0];
      const quality = parts.length >= 3 ? parts[parts.length - 1] : '';
      const name = parts.slice(1, parts.length >= 3 ? -1 : undefined).join('-').replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
      return `${name}${locale || quality ? ` (${[locale, quality].filter(Boolean).join(', ')})` : ''}`.trim();
    }
  } catch {}
  return String(stem);
}

// pure: config.ttsConfig(), fail-soft to {} (so this module never hard-depends on config being loadable).
function safeTtsCfg() { try { return require('./config').ttsConfig() || {}; } catch { return {}; } }

// pure: a fresh, valid-but-empty registry (the fail-soft floor).
function emptyRegistry() { return { version: 1, active: null, surfaces: {}, voices: {} }; }

function createRegistry({ dir = DEFAULT_DIR } = {}) {
  const REGISTRY_PATH = path.join(dir, REGISTRY_BASENAME);
  const ZOE_RECIPE_PATH = path.join(dir, ZOE_RECIPE_BASENAME);
  const st = { reg: null };

  // MIGRATION: synthesize a registry from the current on-disk world (called only when registry.json is absent).
  // Mints `zoe` (Kokoro blend) from zoe_voice.json and one Piper `stock` entry per .onnx sibling. Chooses a
  // sensible `active`: the blend if present, else the currently-configured .onnx, else the first stock voice.
  function migrate() {
    const voices = {};
    let active = null;

    // 1) Zoe's blend — the identity voice — from the existing zoe_voice.json.
    const recipe = readJson(ZOE_RECIPE_PATH);
    if (recipe && recipe.weights && typeof recipe.weights === 'object') {
      voices.zoe = {
        id: 'zoe', name: 'Zoe', kind: 'blend', engine: 'kokoro',
        recipe: { weights: recipe.weights, lang: recipe.lang || 'b', speed: Number(recipe.speed) || 1.0 },
        sample: null, license: 'Apache-2.0', consent: null,
      };
      active = 'zoe';
    }

    // 2) Stock Piper voices — one entry per .onnx in the dir (id = filename stem, guaranteed unique).
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /\.onnx$/i.test(f)); } catch {}
    for (const f of files) {
      const id = f.replace(/\.onnx$/i, '');
      const sidecar = readJson(path.join(dir, `${f}.json`));   // piper config sibling; may carry a license field
      voices[id] = {
        id, name: prettyName(id), kind: 'stock', engine: 'piper',
        modelPath: f, speaker: null,
        license: (sidecar && sidecar.license) || null,   // honest: null when the sibling doesn't declare one
        consent: null,
      };
    }

    // 3) Active fallback when there's no blend: the configured .onnx (by stem), else the first stock voice.
    if (!active) {
      const cfgVoice = safeTtsCfg().voice;
      if (isOnnxPath(cfgVoice)) {
        const id = path.basename(cfgVoice).replace(/\.onnx$/i, '');
        if (voices[id]) active = id;
      }
      if (!active) active = Object.keys(voices)[0] || null;
    }

    const surfaces = {};
    for (const s of SURFACES) surfaces[s] = active;
    return { version: 1, active, surfaces, voices };
  }

  // write the registry to disk, pretty-printed. Fail-soft → { ok, error }; never throws.
  function persist() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(REGISTRY_PATH, JSON.stringify(st.reg, null, 2) + '\n', 'utf8');
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // load (cached). If registry.json is missing, migrate + persist so the seed is stable across runs.
  function load() {
    if (st.reg) return st.reg;
    const onDisk = readJson(REGISTRY_PATH);
    if (onDisk && onDisk.voices && typeof onDisk.voices === 'object') {
      st.reg = { version: onDisk.version || 1, active: onDisk.active || null,
                 surfaces: onDisk.surfaces || {}, voices: onDisk.voices };
    } else {
      st.reg = migrate();
      persist();   // first-boot: bake the migrated registry so it's a stable, editable seed
    }
    return st.reg;
  }
  function reload() { st.reg = null; return load(); }

  // one voice entry (raw) or null.
  function get(id) { const r = load(); return (id && r.voices[id]) || null; }

  // list summaries for a UI: [{ id, name, kind, engine, active }]. Active voice marked.
  function list() {
    const r = load();
    return Object.values(r.voices).map((v) => ({
      id: v.id, name: v.name, kind: v.kind, engine: v.engine, active: v.id === r.active,
    }));
  }

  // build the synth DESCRIPTOR lib/tts.js consumes from a raw entry. Engine decides the params shape.
  function descriptor(v, source) {
    const base = { id: v.id, name: v.name, kind: v.kind, engine: v.engine,
                   license: v.license || null, consent: v.consent || null, policy: v.policy || null, source };
    if (v.engine === 'kokoro') return { ...base, params: { recipe: v.recipe || null } };
    if (v.engine === 'piper')  return { ...base, params: { voice: v.modelPath ? path.join(dir, v.modelPath) : null, speaker: (v.speaker ?? null) } };
    if (v.engine === 'f5')     return { ...base, params: { ref: v.ref || null, record: v.record ? path.join(dir, v.record) : null } };  // Phase 4 fills this in
    return { ...base, params: {} };
  }

  // a legacy .onnx path (today's ZOE_TTS_VOICE / main.js call) resolved as an ad-hoc Piper descriptor,
  // so the app keeps speaking during the migration to registry-driven routing.
  function legacyShim(onnxPath, speaker, source) {
    return { id: '(legacy)', name: '(legacy onnx)', kind: 'stock', engine: 'piper',
             license: null, consent: null, policy: null, source,
             params: { voice: onnxPath, speaker: (speaker ?? null) } };
  }

  // RESOLVE — the one precedence ladder (see module header). Returns a descriptor or null (fail-soft).
  //   1. explicit opts.voice  (registry id, or a legacy .onnx path)
  //   2. surface override      (config.surfaceVoices[surface] first — Phase 8 — then registry.surfaces)
  //   3. config.activeVoice    (Phase 2 config knob; absent today → skipped)
  //   4. registry.active
  //   5. legacy .onnx from cfg.voice  (keeps today's main.js call working)
  function resolve(opts = {}, cfg = null) {
    const r = load();
    cfg = cfg || safeTtsCfg();

    // 1) explicit request
    if (opts.voice) {
      if (isOnnxPath(opts.voice)) return legacyShim(opts.voice, opts.speaker, 'opts.voice');
      if (r.voices[opts.voice]) return descriptor(r.voices[opts.voice], 'opts.voice');
      // unknown id → don't hard-fail; fall through so a bad opts.voice still gets the active voice
    }

    // 2) per-surface override
    if (opts.surface) {
      const cfgSurf = cfg.surfaceVoices && cfg.surfaceVoices[opts.surface];
      if (cfgSurf && r.voices[cfgSurf]) return descriptor(r.voices[cfgSurf], 'surface:config');
      const regSurf = r.surfaces && r.surfaces[opts.surface];
      if (regSurf && r.voices[regSurf]) return descriptor(r.voices[regSurf], 'surface:registry');
    }

    // 3) config-level active voice (Phase 2)
    if (cfg.activeVoice && r.voices[cfg.activeVoice]) return descriptor(r.voices[cfg.activeVoice], 'config.active');

    // 4) registry active
    if (r.active && r.voices[r.active]) return descriptor(r.voices[r.active], 'registry.active');

    // 5) legacy .onnx from config (today's path)
    if (isOnnxPath(cfg.voice)) return legacyShim(cfg.voice, cfg.speaker, 'legacy-onnx');

    return null;   // nothing configured → TTS layer fails soft to silence
  }

  // set the default active voice. Fail-soft; unknown id → { ok:false }.
  function setActive(id) {
    const r = load();
    if (!r.voices[id]) return { ok: false, error: `unknown voice id: ${id}` };
    r.active = id;
    return persist().ok ? { ok: true, active: id } : { ok: false, error: 'persist failed' };
  }

  // route one surface to a voice (Phase 8 uses this from the Studio UI). Fail-soft.
  function setSurface(surface, id) {
    const r = load();
    if (!SURFACES.includes(surface)) return { ok: false, error: `unknown surface: ${surface}` };
    if (!r.voices[id]) return { ok: false, error: `unknown voice id: ${id}` };
    r.surfaces[surface] = id;
    return persist().ok ? { ok: true, surface, id } : { ok: false, error: 'persist failed' };
  }

  // add/replace a voice entry (later phases: save-a-blend, mint-a-clone). Minimal validation here; the
  // consent/license gates for clones live in Phase 5's mint path, layered on top of this raw writer.
  function upsert(entry) {
    const r = load();
    if (!entry || !entry.id || !entry.engine) return { ok: false, error: 'entry needs id + engine' };
    r.voices[entry.id] = { ...entry };
    return persist().ok ? { ok: true, id: entry.id } : { ok: false, error: 'persist failed' };
  }

  // remove a voice entry (soft-delete semantics for clones arrive in Phase 7). Won't orphan `active`.
  function remove(id) {
    const r = load();
    if (!r.voices[id]) return { ok: false, error: `unknown voice id: ${id}` };
    delete r.voices[id];
    if (r.active === id) r.active = Object.keys(r.voices)[0] || null;
    for (const s of Object.keys(r.surfaces)) if (r.surfaces[s] === id) r.surfaces[s] = r.active;
    return persist().ok ? { ok: true, id } : { ok: false, error: 'persist failed' };
  }

  return { load, reload, get, list, resolve, setActive, setSurface, upsert, remove,
           _paths: { dir, REGISTRY_PATH, ZOE_RECIPE_PATH }, _migrate: migrate };
}

// ---- module-level singleton bound to the real data/voices dir (what main.js / lib/tts.js use) ----
let _singleton = null;
function _reg() { if (!_singleton) _singleton = createRegistry({}); return _singleton; }

// ── TONE — the wants project, cut 9 tier A (her wish zero: "modulate my voice"; 2026-09-05) ─────────
// A tone is a BOUNDED DELTA on her recipe, never a different voice: a speed shift within ±0.15 of her
// baseline and a lean of at most 20 points of blend weight toward the softer (af_nicole) or crisper
// (bf_isabella) voice. Pure and idempotent (a recipe already carrying this tone is returned as is), so a
// consumer can never compound deltas. A voice-IDENTITY change is a personality-register change, not a tone.
const TONES = {
  warm:  { speed: -0.05, lean: { af_nicole: 0.15 } },
  dry:   { speed: +0.03 },
  quick: { speed: +0.10 },
  low:   { speed: -0.10, lean: { af_nicole: 0.08 } },
  pause: { pauseMs: 400 },
};
const TONE_SPEED_SPAN = 0.15;      // relative to her baseline
const TONE_LEAN_MAX = 0.20;        // blend points
const SPEED_HARD = [0.7, 1.5];
function toneNames() { return Object.keys(TONES); }
function applyTone(recipe, tone) {
  const t = TONES[String(tone || '').toLowerCase()];
  const base = recipe && typeof recipe === 'object' ? recipe : { weights: {}, lang: 'a', speed: 1.0 };
  if (!t) return { recipe: base, pauseMs: 0, tone: null };
  if (base._tone === tone) return { recipe: base, pauseMs: t.pauseMs || 0, tone };
  const baseline = Number.isFinite(base._baseSpeed) ? base._baseSpeed : (Number(base.speed) || 1.0);
  let speed = baseline + (t.speed || 0);
  speed = Math.max(baseline - TONE_SPEED_SPAN, Math.min(baseline + TONE_SPEED_SPAN, speed));
  speed = Math.max(SPEED_HARD[0], Math.min(SPEED_HARD[1], speed));
  const weights = { ...(base.weights || {}) };
  if (t.lean) {
    for (const [voice, pts] of Object.entries(t.lean)) {
      const shift = Math.min(TONE_LEAN_MAX, Math.max(0, pts));
      const others = Object.keys(weights).filter((k) => k !== voice);
      const pool = others.reduce((s, k) => s + (weights[k] || 0), 0);
      if (!pool) continue;
      for (const k of others) weights[k] = Math.max(0, (weights[k] || 0) - shift * ((weights[k] || 0) / pool));
      weights[voice] = (weights[voice] || 0) + shift;
    }
    const sum = Object.values(weights).reduce((s, v) => s + v, 0) || 1;
    for (const k of Object.keys(weights)) weights[k] = +(weights[k] / sum).toFixed(4);
  }
  return { recipe: { ...base, weights, speed: +speed.toFixed(3), _tone: tone, _baseSpeed: baseline }, pauseMs: t.pauseMs || 0, tone };
}
// The baseline from her state (measured, never scripted; 2026-09-05 his word "what about her tone modulation"):
// the live vector is { drives: { energy… }, vad: { v, a, d } } (lib/internal_state). Energy + arousal shift
// speed by at most ±0.05 together (rested and keyed-up a touch faster; exhausted and flat a touch slower);
// valence leans the blend by at most 10 points — high toward the softer voice, low toward the crisper one.
// ON unless meta voice.state_baseline = '0' (it shipped off; the flat Kokoro he heard this morning was the cost).
function baselineFromState(recipe, internalState, { enabled = true } = {}) {
  const base = recipe && typeof recipe === 'object' ? recipe : { weights: {}, lang: 'a', speed: 1.0 };
  if (!enabled || !internalState) return base;
  const st = internalState;
  const energy = Number.isFinite(st.energy) ? st.energy : (st.drives && Number.isFinite(st.drives.energy) ? st.drives.energy : null);
  const a = st.vad && Number.isFinite(st.vad.a) ? st.vad.a : null;
  const v = st.vad && Number.isFinite(st.vad.v) ? st.vad.v : null;
  if (energy == null && a == null && v == null) return base;
  let dSpeed = 0;
  if (energy != null) dSpeed += (Math.max(0, Math.min(1, energy)) - 0.5) * 0.06;
  if (a != null) dSpeed += (Math.max(0, Math.min(1, a)) - 0.5) * 0.04;
  dSpeed = Math.max(-0.05, Math.min(0.05, dSpeed));
  const speed = Math.max(SPEED_HARD[0], Math.min(SPEED_HARD[1], (Number(base.speed) || 1.0) + dSpeed));
  let weights = { ...(base.weights || {}) }, lean = null;
  if (v != null && Object.keys(weights).length) {
    const pts = Math.max(-0.10, Math.min(0.10, (Math.max(0, Math.min(1, v)) - 0.5) * 0.4));   // v 0.75 → +10 soft; v 0.25 → +10 crisp
    const toward = pts >= 0 ? 'af_nicole' : 'bf_isabella';
    const shift = Math.abs(pts);
    if (shift >= 0.01 && toward in weights) {
      const others = Object.keys(weights).filter((k) => k !== toward);
      const pool = others.reduce((s, k) => s + (weights[k] || 0), 0);
      if (pool > 0) {
        for (const k of others) weights[k] = Math.max(0, (weights[k] || 0) - shift * ((weights[k] || 0) / pool));
        weights[toward] = (weights[toward] || 0) + shift;
        const sum = Object.values(weights).reduce((s, x) => s + x, 0) || 1;
        for (const k of Object.keys(weights)) weights[k] = +(weights[k] / sum).toFixed(4);
        lean = `${toward}+${Math.round(shift * 100)}`;
      }
    }
  }
  return { ...base, weights, speed: +speed.toFixed(3), _baseSpeed: Number(base.speed) || 1.0, _baseline: { dSpeed: +dSpeed.toFixed(3), lean } };
}
/** Her active recipe from the registry (null when none) — the base every tone is a delta on. */
function activeRecipe() {
  try { const r = _reg().load(); const v = r && r.active && r.voices[r.active]; return v && v.recipe ? { ...v.recipe } : null; } catch { return null; }
}

module.exports = {
  createRegistry,
  TONES, toneNames, applyTone, baselineFromState, activeRecipe,
  // thin delegators to the default registry
  load: (...a) => _reg().load(...a),
  reload: (...a) => _reg().reload(...a),
  get: (...a) => _reg().get(...a),
  list: (...a) => _reg().list(...a),
  resolve: (...a) => _reg().resolve(...a),
  setActive: (...a) => _reg().setActive(...a),
  setSurface: (...a) => _reg().setSurface(...a),
  upsert: (...a) => _reg().upsert(...a),
  remove: (...a) => _reg().remove(...a),
  // pure helpers (exported for tests)
  isOnnxPath, prettyName, emptyRegistry,
  DEFAULT_DIR, SURFACES,
};
