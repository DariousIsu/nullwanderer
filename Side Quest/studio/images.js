/**
 * studio/images.js — the IMAGE SUITE: character-creation for the avatar program.
 *
 * Three creators, one SDXL engine (studio/image_client):
 *   PERSONA — an identity/character. description + tags → a base portrait. Saving it makes an AVATAR
 *             (origin:'generated') that appears in the clip maker's roster (shared currency).
 *   SCENERY — a background/environment image.
 *   SCENE   — a persona in a scenery doing something (a composite still).
 *
 * Each generation lands in data/studio/images/<id>/ with its meta (kind, prompt, seed, file). Saving a
 * persona-kind image as an avatar routes through the cloner's persona store with origin:'generated', so
 * generated characters and cloned characters live in the same roster and both drive the clip pipeline.
 *
 * Reference upload + IPAdapter face-lock (carry a specific face across generations) is the next layer;
 * v1 is prompt-driven text-to-image. Fail-soft throughout.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const img = require('./image_client');
const cloner = require('./cloner');

const ROOT = path.resolve(__dirname, '..');
const IMG_DIR = path.join(ROOT, 'data', 'studio', 'images');
const ZOE_REF = path.join(ROOT, 'data', 'avatars', 'zoe_ref.jpg');

// The FULL reference set for a selected avatar — every image the avatar owns (primary + pose library +
// frames added from more videos/photos). IPAdapter averages these, so a richer avatar file yields a
// stronger, more consistent face+body across all generations. Returns [] when no avatar is selected
// (creating a brand-new character generates freely).
function avatarRefs(avatarId) {
  if (avatarId === undefined || avatarId === null) return [];
  if (avatarId === '' || avatarId === 'zoe') return fs.existsSync(ZOE_REF) ? [ZOE_REF] : [];
  const p = cloner.readPersona(avatarId);
  if (!p) return [];
  const dir = path.join(cloner.PERSONAS_DIR, avatarId);
  const names = [...new Set(['ref.png', ...(p.poses || []), ...(p.candidates || [])])];
  const set = names.map(n => path.join(dir, n)).filter(fs.existsSync);
  return set.length ? set : (p.refImage && fs.existsSync(p.refImage) ? [p.refImage] : []);
}

// prompt scaffolding per creator — the house look (photoreal, soft light) so outputs read as one system
const SCAFFOLD = {
  persona: (p) => `${p}, photorealistic portrait, upper body, looking at camera, soft frontal studio lighting, sharp focus, natural skin texture, high detail, 85mm`,
  scenery: (p) => `${p}, establishing shot, no people, cinematic lighting, photorealistic, high detail, depth of field`,
  scene:   (p) => `${p}, photorealistic, cinematic composition, natural lighting, high detail`,
};
const ASPECT = { persona: 'portrait', scenery: 'landscape', scene: 'vertical' };

function listImages() {
  try {
    return fs.readdirSync(IMG_DIR)
      .filter(d => fs.existsSync(path.join(IMG_DIR, d, 'meta.json')))
      .map(d => readImage(d)).filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch { return []; }
}
function readImage(id) {
  try { return JSON.parse(fs.readFileSync(path.join(IMG_DIR, id, 'meta.json'), 'utf8')); }
  catch { return null; }
}

/*
 * create({ kind, prompt, negative?, aspect?, tags?, name? }) → { ok, image } | { ok:false, error }
 * Generates one image and files it. Does NOT auto-register as an avatar — that's an explicit save step.
 */
async function create(opts) {
  try {
    const o = opts || {};
    const kind = ['persona', 'scenery', 'scene'].includes(o.kind) ? o.kind : 'persona';
    const base = String(o.prompt || '').trim();
    if (!base) return { ok: false, error: 'a description is required' };
    const tags = Array.isArray(o.tags) ? o.tags.filter(Boolean).join(', ') : (o.tags || '');
    const fullPrompt = SCAFFOLD[kind]([base, tags].filter(Boolean).join(', '));
    const id = `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const dir = path.join(IMG_DIR, id);
    fs.mkdirSync(dir, { recursive: true });

    // References that steer generation via IPAdapter: a selected avatar's full set (identity lock) PLUS
    // any ad-hoc references the operator uploaded (photos / video frames / a URL frame). Combined + capped.
    const imageRefs = require('./image_refs');
    const explicit = (Array.isArray(o.refIds) ? o.refIds : []).map(id => imageRefs.refPath(id)).filter(Boolean);
    const references = [...new Set([...((o.avatarId !== undefined) ? avatarRefs(o.avatarId) : []), ...explicit])];
    const gen = await img.generate({
      prompt: fullPrompt, negative: o.negative || '', aspect: o.aspect || ASPECT[kind],
      prefix: `suite_${kind}`, references, ipWeight: o.ipWeight || 0.82,
      tier: o.tier === 'lower' ? 'lower' : 'upper', checkpoint: o.checkpoint || null,
      timeoutMs: o.timeoutMs || 300000,
    });
    if (!gen.ok) { fs.rmSync(dir, { recursive: true, force: true }); return gen; }
    const dst = path.join(dir, 'image.png');
    fs.copyFileSync(gen.file, dst);
    const meta = {
      id, kind, name: o.name || `${kind} ${new Date().toISOString().slice(0, 16)}`,
      prompt: base, tags: o.tags || [], fullPrompt, aspect: o.aspect || ASPECT[kind],
      file: dst, createdAt: Date.now(), savedAvatarId: null,
      avatarId: (o.avatarId !== undefined && o.avatarId !== '') ? o.avatarId : null,
      identityLocked: references.length > 0, refsUsed: references.length,
      tier: o.tier === 'lower' ? 'lower' : 'upper',
    };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    return { ok: true, image: meta };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

/*
 * saveAsAvatar(imageId, name) — promote a PERSONA image to an avatar in the shared roster. Reuses the
 * cloner's persona store but marks origin:'generated' and post-eligible (a generated character is not a
 * real person, so — unlike a 1:1 clone — it CAN be posted).
 */
function saveAsAvatar(imageId, name) {
  const im = readImage(imageId);
  if (!im) return { ok: false, error: 'no such image' };
  if (im.kind !== 'persona') return { ok: false, error: 'only persona images become avatars' };
  const id = `persona_gen_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const dir = path.join(cloner.PERSONAS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(im.file, path.join(dir, 'ref.png'));
  const persona = {
    id, name: name || im.name, createdAt: Date.now(),
    origin: 'generated',              // a generated character, not a cloned real person
    oneToOne: false, postEligible: true,   // synthetic → postable (unlike a 1:1 clone)
    consent: 'n/a (synthetic generated character)', attestedBy: 'image-suite', attestedAt: Date.now(),
    sources: ['image.png'], refImage: path.join(dir, 'ref.png'), refBasename: 'ref.png',
    poses: ['ref.png'], candidates: [], voiceSamples: [], voice: null,
    voiceStatus: 'default program voice (pick one in the roster)',
    sourcePrompt: im.fullPrompt,
  };
  cloner.savePersona(persona);
  // link back
  im.savedAvatarId = id;
  fs.writeFileSync(path.join(IMG_DIR, imageId, 'meta.json'), JSON.stringify(im, null, 2));
  return { ok: true, avatarId: id };
}

function remove(id) {
  try { fs.rmSync(path.join(IMG_DIR, id), { recursive: true, force: true }); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
}

module.exports = { create, listImages, readImage, saveAsAvatar, remove, IMG_DIR };
