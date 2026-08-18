/* QR Studio surface — branded QR builder. Ports Echo's QR Studio into My Workspace. Calls
   window.sq.qr.* over IPC; the engine (qr_* tools) renders the QR server-side and returns a
   decode-verified data: URL, so this surface owns the DESIGN + draws what comes back. Two tabs:
   Generate (live engine-rendered preview + download + save) and Gallery (saved QRs + per-QR
   scan analytics). No local QR lib, no model — the builder IS the engine surface. */
'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;

// ---- design state (one cohesive object; presets/kits drive it wholesale) ----
const DEFAULT_DESIGN = {
  mode: 'styled', data: 'https://raineycenter.org/',
  dark: '#0aa3aa', light: '#ffffff',
  moduleShape: 'rounded', eyeFrame: 'rounded', eyeBall: 'rounded',
  colorMask: 'solid', gradientTo: '#662d91',
  pad_shape: 'rounded', pad_color: '#ffffff',
  border_color: '', border_width: 0, shadow: false, knockout: true,
  logoSrc: '', logoName: '', logoFrac: 0.22,
  frame: '', caption: '', tagline: '',
  halftone_smooth: true, halftone_source_contrast: 1.2, halftone_source_saturation: 1.0,
  halftone_background_tint: 'white', halftone_density: 'auto',
  halftone_recolor_structural: false, halftone_structural_darkness: 0.55,
  halftone_structural_shape: 'square',
  halftone_source_offset_x: 0, halftone_source_offset_y: 0,
  halftone_center_logo: false, halftone_center_logo_frac: 0.22, halftone_center_pad_shape: 'circle',
};
let design = { ...DEFAULT_DESIGN };
let payloadType = 'url';
let payloadFields = {};
let label = '', campaign = '';
let designOpts = null, payloadTypes = [];
let savedKits = [];
try { savedKits = JSON.parse(localStorage.getItem('qr-studio-kits') || '[]'); } catch { savedKits = []; }

// Brand presets — engine vocabulary (module_shapes / eye_frame_shapes from qr_design_options).
const PRESETS = [
  { id: 'bold', pl: 'Bold', ps: 'Square modules, mono', d: { mode: 'styled', moduleShape: 'square', eyeFrame: 'square', eyeBall: 'square', colorMask: 'solid', dark: '#000000', pad_shape: 'rounded', knockout: true } },
  { id: 'minimal', pl: 'Minimal', ps: 'Rounded, soft pad', d: { mode: 'styled', moduleShape: 'rounded', eyeFrame: 'rounded', eyeBall: 'rounded', colorMask: 'solid', dark: '#0aa3aa', pad_shape: 'rounded', knockout: true, logoFrac: 0.20 } },
  { id: 'cyan', pl: 'Brand · Cyan', ps: 'Radial gradient', d: { mode: 'styled', moduleShape: 'rounded', eyeFrame: 'rounded', eyeBall: 'circle', colorMask: 'radial-gradient', dark: '#0aa3aa', gradientTo: '#1d3557', pad_shape: 'rounded', knockout: true, shadow: true } },
  { id: 'violet', pl: 'Brand · Violet', ps: 'Square gradient', d: { mode: 'styled', moduleShape: 'gapped-square', eyeFrame: 'rounded', eyeBall: 'rounded', colorMask: 'square-gradient', dark: '#662d91', gradientTo: '#0aa3aa', pad_shape: 'circle', knockout: true, shadow: true } },
  { id: 'event', pl: 'Event poster', ps: 'Frame + dark bg', d: { mode: 'plain', moduleShape: 'square', eyeFrame: 'square', eyeBall: 'square', colorMask: 'solid', dark: '#ffffff', light: '#0b1726', frame: 'event-poster', caption: 'EVENT NAME', tagline: 'Scan to RSVP' } },
];
function randomDesign() {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const masks = (designOpts && designOpts.color_masks) || ['solid', 'radial-gradient', 'square-gradient', 'horizontal-gradient', 'vertical-gradient'];
  const palette = ['#0aa3aa', '#662d91', '#1d3557', '#b3261e', '#0b6b3a', '#f2c91e', '#000000', '#1a73e8'];
  Object.assign(design, {
    mode: 'styled',
    moduleShape: pick((designOpts && designOpts.module_shapes) || ['square', 'rounded', 'circle']),
    eyeFrame: pick((designOpts && designOpts.eye_frame_shapes) || ['square', 'rounded']),
    eyeBall: pick((designOpts && designOpts.eye_ball_shapes) || ['square', 'rounded']),
    colorMask: pick(masks), dark: pick(palette), gradientTo: pick(palette),
    pad_shape: pick(['rounded', 'circle']), knockout: true,
  });
}

// ---- engine arg assembly ----
function genArgs(scale) {
  const a = {
    data: (design.data || '').trim(), mode: design.mode,
    dark: design.dark, light: design.light,
    logo: design.logoSrc || undefined, logo_frac: design.logoFrac,
    scale: scale || 10, fmt: 'png',
    payload_type: payloadType,
    module_shape: design.moduleShape, eye_shape: design.eyeFrame,
    eye_frame: design.eyeFrame, eye_ball: design.eyeBall,
    color_mask: design.colorMask,
    pad_shape: design.pad_shape, pad_color: design.pad_color,
    shadow: design.shadow, knockout: design.knockout,
  };
  if (payloadType !== 'url') a.payload_fields = payloadFields;
  if (design.colorMask !== 'solid') a.gradient_to = design.gradientTo;
  if (design.border_color) { a.border_color = design.border_color; a.border_width = design.border_width; }
  if (design.frame) { a.frame = design.frame; if (design.caption) a.caption = design.caption; if (design.tagline) a.tagline = design.tagline; }
  if (design.mode === 'halftone') Object.assign(a, {
    halftone_smooth: design.halftone_smooth,
    halftone_source_contrast: design.halftone_source_contrast,
    halftone_source_saturation: design.halftone_source_saturation,
    halftone_background_tint: design.halftone_background_tint,
    halftone_density: design.halftone_density,
    halftone_recolor_structural: design.halftone_recolor_structural,
    halftone_structural_darkness: design.halftone_structural_darkness,
    halftone_structural_shape: design.halftone_structural_shape,
    halftone_source_offset_x: design.halftone_source_offset_x,
    halftone_source_offset_y: design.halftone_source_offset_y,
    halftone_center_logo: design.halftone_center_logo,
    halftone_center_logo_frac: design.halftone_center_logo_frac,
    halftone_center_pad_shape: design.halftone_center_pad_shape,
  });
  return a;
}
function requiredMissing() {
  if (payloadType === 'url') return !(design.data || '').trim();
  const spec = payloadTypes.find(t => t.type === payloadType);
  if (!spec) return false;
  return spec.fields.some(f => f.required && (payloadFields[f.key] === undefined || payloadFields[f.key] === '' || payloadFields[f.key] === null));
}

// ======================= LIVE PREVIEW =======================
let previewTimer = null, previewSeq = 0;
function schedulePreview() {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 320);
}
async function renderPreview() {
  const box = $('pvbox');
  if (requiredMissing()) {
    box.innerHTML = `<div class="ph">${payloadType === 'url' ? 'Enter a link…' : 'Fill the required field' + '…'}</div>`;
    setDecode(undefined, null); $('encoded').textContent = '';
    return;
  }
  const seq = ++previewSeq;
  box.classList.add('busy');
  try {
    const r = await window.sq.qr.generate(genArgs(10));
    if (seq !== previewSeq) return;               // a newer render superseded this one
    if (r && r.ok && r.data_url) {
      box.innerHTML = `<img src="${r.data_url}" alt="QR preview">`;
      setDecode(r.scannable, r.decoded || null);
      $('encoded').textContent = r.payload_summary || r.encoded || (design.data || '').trim();
      $('genErr').hidden = true;
    } else {
      setDecode(undefined, null);
      $('genErr').hidden = false; $('genErr').textContent = '⚠ ' + ((r && r.error) || 'render failed');
    }
  } catch (e) {
    if (seq !== previewSeq) return;
    $('genErr').hidden = false; $('genErr').textContent = '⚠ ' + (e.message || String(e));
  } finally {
    if (seq === previewSeq) box.classList.remove('busy');
  }
}
function setDecode(scannable, decoded) {
  const el = $('decode');
  el.className = 'decode ' + (scannable === true ? 'ok' : scannable === false ? 'warn' : 'none');
  $('decIcon').textContent = scannable === true ? '✓' : scannable === false ? '!' : '';
  $('decMsg').textContent = scannable === true ? 'Verified — scans cleanly'
    : scannable === false ? 'May not scan — shrink the logo or pick a simpler eye/shape'
    : scannable === null ? 'Decoder unavailable on the engine (skipped)'
    : 'Awaiting first render…';
  $('decTxt').textContent = (scannable === true && decoded) ? '→ ' + decoded : '';
}

// ======================= LEFT RAIL (presets + kits) =======================
function renderRail() {
  const kitsHtml = savedKits.length
    ? savedKits.map((k, i) => `<div class="kit"><span class="kn" data-kit="${i}" title="Apply kit">${esc(k.name)}</span><span class="kx" data-delkit="${i}" title="Delete">✕</span></div>`).join('')
    : `<div class="muted-note">Save the current design as a reusable brand kit.</div>`;
  $('railL').innerHTML = `
    <div class="rail-grp">Presets</div>
    ${PRESETS.map(p => `<button class="preset" data-preset="${p.id}"><div class="pl">${esc(p.pl)}</div><div class="ps">${esc(p.ps)}</div></button>`).join('')}
    <button class="preset dashed" data-random="1"><div class="pl">⤨ Randomize</div><div class="ps">Surprise me</div></button>
    <div class="rail-grp mt" style="display:flex;justify-content:space-between;align-items:center;">
      <span>Saved kits</span><span class="kx" id="saveKit" title="Save current design as a kit" style="cursor:pointer;">＋</span>
    </div>
    ${kitsHtml}`;
}
function applyPreset(id) { const p = PRESETS.find(x => x.id === id); if (p) { Object.assign(design, p.d); buildControls(); schedulePreview(); } }
function saveKit() {
  dialog({ title: 'Save brand kit', input: { placeholder: 'Kit name', default: label || 'My kit' }, ok: 'Save' }).then(name => {
    if (!name) return;
    const kit = {
      mode: design.mode, dark: design.dark, light: design.light,
      module_shape: design.moduleShape, eye_frame: design.eyeFrame, eye_ball: design.eyeBall,
      color_mask: design.colorMask, gradient_to: design.gradientTo,
      pad_shape: design.pad_shape, pad_color: design.pad_color,
      shadow: design.shadow, knockout: design.knockout, logo_frac: design.logoFrac,
    };
    savedKits.push({ name, kit });
    localStorage.setItem('qr-studio-kits', JSON.stringify(savedKits));
    renderRail();
  });
}
function applyKit(kit) {
  Object.assign(design, {
    mode: kit.mode || design.mode, dark: kit.dark || design.dark, light: kit.light || design.light,
    moduleShape: kit.module_shape || design.moduleShape,
    eyeFrame: kit.eye_frame || kit.eye_shape || design.eyeFrame,
    eyeBall: kit.eye_ball || kit.eye_shape || design.eyeBall,
    colorMask: kit.color_mask || design.colorMask, gradientTo: kit.gradient_to || design.gradientTo,
    pad_shape: kit.pad_shape || design.pad_shape, pad_color: kit.pad_color || design.pad_color,
    shadow: !!kit.shadow, knockout: kit.knockout != null ? kit.knockout : design.knockout,
    logoFrac: kit.logo_frac != null ? kit.logo_frac : design.logoFrac,
  });
  buildControls(); schedulePreview();
}

// ======================= CENTER CONTROLS =======================
function chips(act, options, current) {
  return `<div class="chips">${options.map(o => `<button class="chip${o === current ? ' on' : ''}" data-act="${act}" data-val="${esc(o)}">${esc(o)}</button>`).join('')}</div>`;
}
function colorField(field, val) {
  return `<div class="colorfld"><input type="color" value="${esc(val)}" data-color="${field}"><input class="hex" type="text" value="${esc(val)}" data-hex="${field}" spellcheck="false"></div>`;
}
function rangeField(field, val, min, max, suffix) {
  return `<div class="rangefld"><div class="rh"><span class="lbl" style="margin:0;">${field.label}</span><span class="rv" data-rv="${field.k}">${val}${suffix || ''}</span></div>
    <input type="range" min="${min}" max="${max}" value="${val}" data-range="${field.k}"></div>`;
}
function payloadFormHtml() {
  if (payloadType === 'url') return `<input type="text" id="dataUrl" value="${esc(design.data)}" placeholder="https://… or any text" autocomplete="off" spellcheck="false">`;
  const spec = payloadTypes.find(t => t.type === payloadType);
  if (!spec) return '';
  return spec.fields.map(f => {
    const v = payloadFields[f.key] != null ? payloadFields[f.key] : '';
    const reqm = f.required ? '<span class="req">*</span>' : '';
    if (f.input === 'multiline') return `<label class="fld"><span>${esc(f.label)}${reqm}</span><textarea data-pf="${f.key}">${esc(v)}</textarea></label>`;
    if (f.input === 'select') return `<label class="fld"><span>${esc(f.label)}${reqm}</span><select data-pf="${f.key}"><option value="">—</option>${(f.options || []).map(o => `<option value="${esc(o)}"${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
    if (f.input === 'checkbox') return `<label class="ck" style="margin:4px 0 10px;"><input type="checkbox" data-pf="${f.key}"${v ? ' checked' : ''}> ${esc(f.label)}</label>`;
    const t = f.input === 'datetime' ? 'datetime-local' : f.input === 'password' ? 'password' : f.input === 'number' ? 'number' : 'text';
    return `<label class="fld"><span>${esc(f.label)}${reqm}</span><input type="${t}" data-pf="${f.key}" value="${esc(v)}"></label>`;
  }).join('');
}
function buildControls() {
  const o = designOpts || {};
  const moduleShapes = o.module_shapes || ['square', 'rounded', 'gapped-square', 'circle', 'horizontal-bars', 'vertical-bars'];
  const eyeFrames = o.eye_frame_shapes || ['square', 'rounded', 'gapped-square', 'circle'];
  const eyeBalls = o.eye_ball_shapes || ['square', 'rounded', 'gapped-square', 'circle'];
  const masks = o.color_masks || ['solid', 'radial-gradient', 'square-gradient', 'horizontal-gradient', 'vertical-gradient'];
  const pads = o.pad_shapes || ['rounded', 'circle', 'none'];
  const modes = o.modes || ['plain', 'styled', 'logo', 'artistic', 'halftone'];
  const frames = o.frames || ['card', 'event-poster', 'scan-to-action', 'simple'];
  const typeLabel = (t) => ({ mailto: 'Email', tel: 'Call', appstore: 'App', payment: 'Pay', sms: 'SMS', wifi: 'Wi-Fi', url: 'URL' }[t] || cap(t));

  $('controls').innerHTML = `
    <div class="sec"><div class="sec-h">Payload</div><div class="sec-b">
      <div class="chips" style="margin-bottom:10px;">
        ${payloadTypes.map(t => `<button class="chip${t.type === payloadType ? ' on' : ''}" data-ptype="${t.type}" title="${esc(t.summary)}">${esc(typeLabel(t.type))}</button>`).join('')}
      </div>
      <div id="payloadForm">${payloadFormHtml()}</div>
    </div></div>

    <div class="sec"><div class="sec-h">Modules</div><div class="sec-b">
      <div class="lbl">Render mode</div>${chips('mode', modes, design.mode)}
      <div class="lbl mt">Body shape <span style="color:var(--tx-fainter);text-transform:none;letter-spacing:0;">(styled mode)</span></div>${chips('moduleShape', moduleShapes, design.moduleShape)}
    </div></div>

    <div class="sec"><div class="sec-h">Eyes</div><div class="sec-b">
      <div class="lbl">Frame · 7×7 outer</div>${chips('eyeFrame', eyeFrames, design.eyeFrame)}
      <div class="lbl mt">Ball · 3×3 center</div>${chips('eyeBall', eyeBalls, design.eyeBall)}
    </div></div>

    <div class="sec"><div class="sec-h">Colors</div><div class="sec-b">
      <div class="row2">
        <div><div class="lbl">Foreground</div>${colorField('dark', design.dark)}</div>
        <div><div class="lbl">Background</div>${colorField('light', design.light)}</div>
      </div>
      <div class="lbl mt">Gradient</div>${chips('colorMask', masks, design.colorMask)}
      <div id="gradToWrap" ${design.colorMask === 'solid' ? 'hidden' : ''}><div class="lbl mt">Gradient → color</div>${colorField('gradientTo', design.gradientTo)}</div>
    </div></div>

    <div class="sec"><div class="sec-h">Logo</div><div class="sec-b">
      <div style="display:flex;gap:8px;align-items:center;">
        <label class="upload">⇧ Upload<input type="file" accept="image/*" id="logoFile"></label>
        <input type="text" id="logoUrl" placeholder="…or paste image URL" value="${esc(design.logoSrc.startsWith('data:') ? '' : design.logoSrc)}">
        <span class="kx" id="logoClear" title="Remove logo" ${design.logoSrc ? '' : 'style="display:none;"'}>✕</span>
      </div>
      <div class="subnote" id="logoName">${esc(design.logoName || '')}</div>
      ${rangeField({ k: 'logoFrac', label: 'Logo size' }, Math.round(design.logoFrac * 100), 10, 40, '%')}
      <div class="lbl">Pad shape</div>${chips('pad_shape', pads, design.pad_shape)}
      <div class="checks">
        <label class="ck"><input type="checkbox" data-ck="knockout"${design.knockout ? ' checked' : ''}> Knockout</label>
        <label class="ck"><input type="checkbox" data-ck="shadow"${design.shadow ? ' checked' : ''}> Shadow</label>
      </div>
      <div class="subnote">Logo / Artistic / Halftone modes need an uploaded image.</div>
      <div class="halftone" id="htSec" ${design.mode === 'halftone' ? '' : 'hidden'}>
        <div class="htitle">Halftone polish</div>
        <div class="lbl">Background tint</div>${chips('halftone_background_tint', ['white', 'logo', 'transparent'], design.halftone_background_tint)}
        <div class="lbl mt">Density</div>${chips('halftone_density', ['auto', 'coarse', 'medium', 'fine'], design.halftone_density)}
        ${rangeField({ k: 'halftone_source_contrast', label: 'Source contrast' }, Math.round(design.halftone_source_contrast * 100), 80, 200, '%')}
        ${rangeField({ k: 'halftone_source_saturation', label: 'Source saturation' }, Math.round(design.halftone_source_saturation * 100), 50, 250, '%')}
        <div class="row2">
          ${rangeField({ k: 'halftone_source_offset_x', label: 'Nudge X' }, Math.round(design.halftone_source_offset_x * 100), -30, 30, '%')}
          ${rangeField({ k: 'halftone_source_offset_y', label: 'Nudge Y' }, Math.round(design.halftone_source_offset_y * 100), -30, 30, '%')}
        </div>
        <div class="lbl">Finder + alignment shape</div>${chips('halftone_structural_shape', ['square', 'rounded', 'extra-rounded'], design.halftone_structural_shape)}
        <div class="checks">
          <label class="ck"><input type="checkbox" data-ck="halftone_recolor_structural"${design.halftone_recolor_structural ? ' checked' : ''}> Recolor finders to logo color</label>
          <label class="ck"><input type="checkbox" data-ck="halftone_smooth"${design.halftone_smooth ? ' checked' : ''}> Smooth output</label>
          <label class="ck"><input type="checkbox" data-ck="halftone_center_logo"${design.halftone_center_logo ? ' checked' : ''}> Sharp center logo</label>
        </div>
      </div>
    </div></div>

    <div class="sec"><div class="sec-h">Frame</div><div class="sec-b">
      ${chips('frame', ['', ...frames].map(f => f), design.frame).replace('data-val=""', 'data-val="" title="No frame"')}
      <div id="frameText" ${design.frame ? '' : 'hidden'} style="margin-top:9px;">
        <label class="fld"><span>Caption</span><input type="text" id="capIn" value="${esc(design.caption)}" placeholder="e.g. LAMP Briefing"></label>
        <label class="fld"><span>Tagline</span><input type="text" id="tagIn" value="${esc(design.tagline)}" placeholder="e.g. Scan to RSVP"></label>
        <div class="subnote">Frames render server-side; the preview shows the wrapped image.</div>
      </div>
    </div></div>

    <div class="sec"><div class="sec-h">Save &amp; track</div><div class="sec-b">
      <div class="row2">
        <input type="text" id="labelIn" placeholder="Label" value="${esc(label)}">
        <input type="text" id="campIn" placeholder="Campaign" value="${esc(campaign)}">
      </div>
      <div class="subnote">Save mints a tracked <b>/r/&lt;slug&gt;</b> redirect (URL payloads) so scans land in the gallery analytics. Use the <b>Save &amp; track →</b> button on the right.</div>
    </div></div>`;

  // relabel the empty frame chip as "none"
  const noneChip = $('controls').querySelector('.chip[data-act="frame"][data-val=""]');
  if (noneChip) noneChip.textContent = 'none';
}

// ---- control event delegation ----
function onControlsClick(e) {
  if (e.target.id === 'logoClear') { design.logoSrc = ''; design.logoName = ''; const lu = $('logoUrl'); if (lu) lu.value = ''; const ln = $('logoName'); if (ln) ln.textContent = ''; e.target.style.display = 'none'; schedulePreview(); return; }
  const chip = e.target.closest('.chip');
  if (chip && chip.dataset.act) {
    const act = chip.dataset.act, val = chip.dataset.val;
    if (act === 'logoFrac') return;
    design[act] = (act === 'border_width') ? Number(val) : val;
    chip.parentElement.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c === chip));
    if (act === 'mode') { const s = $('htSec'); if (s) s.hidden = design.mode !== 'halftone'; }
    if (act === 'colorMask') { const w = $('gradToWrap'); if (w) w.hidden = design.colorMask === 'solid'; }
    if (act === 'frame') { const w = $('frameText'); if (w) w.hidden = !design.frame; }
    schedulePreview();
    return;
  }
  if (chip && chip.dataset.ptype) {
    payloadType = chip.dataset.ptype; payloadFields = {};
    $('controls').querySelectorAll('.chip[data-ptype]').forEach(c => c.classList.toggle('on', c === chip));
    $('payloadForm').innerHTML = payloadFormHtml();
    schedulePreview();
    return;
  }
  const preset = e.target.closest('[data-preset]'); if (preset) return applyPreset(preset.dataset.preset);
  if (e.target.closest('[data-random]')) { randomDesign(); buildControls(); schedulePreview(); return; }
}
function onControlsInput(e) {
  const t = e.target;
  if (t.id === 'dataUrl') { design.data = t.value; schedulePreview(); return; }
  if (t.dataset.pf != null) {
    const k = t.dataset.pf;
    payloadFields[k] = t.type === 'checkbox' ? t.checked : (t.type === 'number' ? (t.value === '' ? '' : Number(t.value)) : t.value);
    schedulePreview(); return;
  }
  if (t.dataset.color != null) { design[t.dataset.color] = t.value; const hx = $('controls').querySelector(`[data-hex="${t.dataset.color}"]`); if (hx) hx.value = t.value; schedulePreview(); return; }
  if (t.dataset.hex != null) { let v = t.value.trim(); if (/^#?[0-9a-fA-F]{6}$/.test(v)) { v = v[0] === '#' ? v : '#' + v; design[t.dataset.hex] = v; const c = $('controls').querySelector(`[data-color="${t.dataset.hex}"]`); if (c) c.value = v; schedulePreview(); } return; }
  if (t.dataset.range != null) {
    const k = t.dataset.range, raw = Number(t.value);
    const rv = $('controls').querySelector(`[data-rv="${k}"]`);
    if (k === 'logoFrac') { design.logoFrac = raw / 100; if (rv) rv.textContent = raw + '%'; }
    else if (k.startsWith('halftone_source_offset')) { design[k] = raw / 100; if (rv) rv.textContent = raw + '%'; }
    else if (k === 'halftone_source_contrast' || k === 'halftone_source_saturation') { design[k] = raw / 100; if (rv) rv.textContent = raw + '%'; }
    else { design[k] = raw; if (rv) rv.textContent = raw; }
    schedulePreview(); return;
  }
  if (t.dataset.ck != null) { design[t.dataset.ck] = t.checked; schedulePreview(); return; }
  if (t.id === 'logoUrl') { design.logoSrc = t.value; design.logoName = ''; $('logoName').textContent = ''; $('logoClear').style.display = t.value ? '' : 'none'; schedulePreview(); return; }
  if (t.id === 'capIn') { design.caption = t.value; schedulePreview(); return; }
  if (t.id === 'tagIn') { design.tagline = t.value; schedulePreview(); return; }
  if (t.id === 'labelIn') { label = t.value; return; }
  if (t.id === 'campIn') { campaign = t.value; return; }
}
async function onLogoFile(e) {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(f); });
  design.logoSrc = url; design.logoName = f.name;
  $('logoName').textContent = f.name; $('logoClear').style.display = ''; const lu = $('logoUrl'); if (lu) lu.value = '';
  schedulePreview();
}

// ======================= DOWNLOAD + SAVE =======================
function sizeToScale(px) { return Math.max(6, Math.min(20, Math.round(px / 36))); }
async function download(fmt) {
  if (requiredMissing()) return;
  const px = Number($('exportSize').value) || 512;
  const args = genArgs(sizeToScale(px)); args.fmt = fmt;
  const btn = fmt === 'svg' ? $('dlSvg') : $('dlPng'); const old = btn.textContent; btn.textContent = '…'; btn.disabled = true;
  try {
    const r = await window.sq.qr.generate(args);
    if (r && r.ok && r.data_url) {
      const res = await window.sq.qr.download(r.data_url, (label || 'qr').replace(/\s+/g, '_'));
      if (!res || !res.ok) flashErr((res && res.error) || 'download failed');
    } else flashErr((r && r.error) || 'render failed');
  } catch (e) { flashErr(e.message || String(e)); }
  finally { btn.textContent = old; btn.disabled = false; }
}
function flashErr(msg) { const el = $('genErr'); el.hidden = false; el.textContent = '⚠ ' + msg; }
async function saveAndTrack() {
  if (requiredMissing()) { flashErr(payloadType === 'url' ? 'enter a link first' : 'fill the required field first'); return; }
  const btn = $('saveTrack'); btn.disabled = true; const old = btn.textContent; btn.textContent = 'Saving…';
  try {
    const args = genArgs(12); args.label = label; args.campaign = campaign;
    const r = await window.sq.qr.save(args);
    if (r && r.ok && r.slug) { setTab('gallery', r.slug); }
    else flashErr((r && r.error) || 'save failed');
  } catch (e) { flashErr(e.message || String(e)); }
  finally { btn.disabled = false; btn.textContent = old; }
}

// ======================= GALLERY =======================
const fmtDate = (ep) => ep ? new Date(ep * 1000).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
async function loadGallery(focusSlug) {
  const w = $('gwrap');
  if (focusSlug) return openAnalytics(focusSlug);
  w.innerHTML = `<div class="status">Loading gallery…</div>`;
  let r;
  try { r = await window.sq.qr.list({ active_only: true }); }
  catch (e) { w.innerHTML = `<div class="err">⚠ ${esc(e.message || String(e))}</div>`; return; }
  if (!r || !r.ok) { w.innerHTML = `<div class="err">⚠ ${esc((r && r.error) || 'failed to load gallery')}</div>`; return; }
  const qrs = r.qrs || [];
  if (!qrs.length) {
    w.innerHTML = `<div class="gempty"><div class="big">No saved QRs yet</div><div class="small">Build one on the Generate tab and hit <b>Save &amp; track →</b>.</div></div>`;
    return;
  }
  w.innerHTML = `<div class="gnote">Every saved QR encodes a tracked redirect — click one for its scan analytics.</div>
    <div class="ggrid">${qrs.map(q => `
      <div class="gcard" data-slug="${esc(q.slug)}">
        <div class="thumb" data-thumb="${esc(q.slug)}"><span class="status">…</span></div>
        <div class="gl"><span class="gt">${esc(q.label || q.slug)}</span><span class="gc">⟳ ${q.scan_count || 0}</span></div>
        <div class="gd" title="${esc(q.dest_url)}">${esc(q.dest_url)}</div>
        ${q.campaign ? `<div class="gtag">${esc(q.campaign)}</div>` : ''}
        <span class="dup" data-dup="${esc(q.slug)}" data-dest="${esc(q.dest_url)}" data-label="${esc(q.label || '')}">⧉ Duplicate</span>
      </div>`).join('')}</div>`;
  // lazy thumbnails
  qrs.forEach(async (q) => {
    try {
      const rr = await window.sq.qr.renderSaved(q.slug, 'png');
      const cell = w.querySelector(`[data-thumb="${cssSlug(q.slug)}"]`);
      if (cell) cell.innerHTML = (rr && rr.ok && rr.data_url) ? `<img src="${rr.data_url}" alt="${esc(q.label || q.slug)}">` : '<span class="status">—</span>';
    } catch { /* leave placeholder */ }
  });
}
const cssSlug = (s) => String(s).replace(/["\\]/g, '\\$&');
async function onGalleryClick(e) {
  const dup = e.target.closest('[data-dup]');
  if (dup) {
    e.stopPropagation();
    const dest = await dialog({ title: 'Duplicate QR', message: 'Same brand kit, new destination.', input: { placeholder: 'New URL', default: dup.dataset.dest }, ok: 'Duplicate' });
    if (!dest) return;
    const r = await window.sq.qr.clone({ source_slug: dup.dataset.dup, data: dest, label: (dup.dataset.label ? dup.dataset.label + ' (copy)' : '') });
    if (r && r.ok) loadGallery(); else flashModal((r && r.error) || 'clone failed');
    return;
  }
  const card = e.target.closest('.gcard'); if (card) openAnalytics(card.dataset.slug);
}
async function openAnalytics(slug) {
  const w = $('gwrap');
  w.innerHTML = `<div class="status">Loading analytics…</div>`;
  let r;
  try { r = await window.sq.qr.analytics(slug, 30); }
  catch (e) { w.innerHTML = `<div class="err">⚠ ${esc(e.message || String(e))}</div>`; return; }
  if (!r || !r.ok || !r.qr) { w.innerHTML = `<div class="err">⚠ ${esc((r && r.error) || 'failed to load analytics')}</div><div class="aback" data-back="1">← Back to gallery</div>`; bindBack(); return; }
  const q = r.qr;
  const max = Math.max(1, ...((r.by_day || []).map(d => d.count)));
  w.innerHTML = `
    <div class="aback" data-back="1">← Back to gallery</div>
    <div class="acard">
      <div class="athumb" data-athumb="1"><span class="status">…</span></div>
      <div class="ainfo">
        <div class="ah">${esc(q.label || q.slug)}</div>
        <div class="afld"><span class="ak">Destination</span><span class="av"><a href="${esc(q.dest_url)}" target="_blank" rel="noreferrer">${esc(q.dest_url)} ↗</a></span></div>
        ${q.redirect_url ? `<div class="afld"><span class="ak">Redirect</span><span class="av">${esc(q.redirect_url)}</span></div>` : ''}
        <div class="afld"><span class="ak">Slug</span><span class="av">${esc(q.slug)}</span></div>
        ${q.campaign ? `<div class="afld"><span class="ak">Campaign</span><span class="av">${esc(q.campaign)}</span></div>` : ''}
        <div class="afld"><span class="ak">Created</span><span class="av">${esc(fmtDate(q.created_at))}</span></div>
      </div>
      <div class="aact">
        <button class="btn" data-dl="png" data-slug="${esc(slug)}">Download PNG</button>
        <button class="btn" data-dl="svg" data-slug="${esc(slug)}">Download SVG</button>
        <button class="btn" data-arch="${esc(slug)}" style="color:var(--warn-fg);">Archive</button>
      </div>
    </div>
    <div class="kpis">
      <div class="kpi"><div class="kl">Total scans</div><div class="kv">${r.total_scans || 0}</div></div>
      <div class="kpi"><div class="kl">Last ${r.window_days || 30}d</div><div class="kv">${r.recent_scans || 0}</div></div>
      <div class="kpi"><div class="kl">Last scan</div><div class="kv sm">${r.last_scan_at ? esc(fmtDate(r.last_scan_at)) : 'never'}</div></div>
    </div>
    ${(r.by_day || []).length ? `<div class="panel"><div class="ptitle">Scans by day</div>
      <div class="bars">${r.by_day.map(d => `<div class="bcol" title="${esc(d.day)}: ${d.count}"><i style="height:${Math.round((d.count / max) * 100)}%"></i></div>`).join('')}</div>
      <div class="brange"><span>${esc(r.by_day[0].day)}</span><span>${esc(r.by_day[r.by_day.length - 1].day)}</span></div></div>` : ''}
    ${(r.top_referers || []).length ? `<div class="panel"><div class="ptitle">Top referers</div><ul class="reflist">${r.top_referers.map(x => `<li><span class="rn">${esc(x.referer)}</span><span class="rc">${x.count}</span></li>`).join('')}</ul></div>` : ''}
    ${(r.recent || []).length ? `<div class="scans"><div class="sh">Recent scans</div><ul>${r.recent.map(s => `<li><span class="st">${esc(fmtDate(s.scanned_at))}</span><span class="su" title="${esc(s.user_agent)}">${esc(s.user_agent || '—')}</span>${(s.city || s.country) ? `<span class="sl">${esc([s.city, s.country].filter(Boolean).join(', '))}</span>` : ''}</li>`).join('')}</ul></div>` : '<div class="status">No scans recorded yet. Tracking needs the engine portal reachable at a public URL (config).</div>'}`;
  bindBack();
  window.sq.qr.renderSaved(slug, 'png').then(rr => { const c = w.querySelector('[data-athumb]'); if (c) c.innerHTML = (rr && rr.ok && rr.data_url) ? `<img src="${rr.data_url}">` : '<span class="status">—</span>'; }).catch(() => {});
  w.querySelectorAll('[data-dl]').forEach(b => b.addEventListener('click', async () => {
    const fmt = b.dataset.dl; const old = b.textContent; b.textContent = '…'; b.disabled = true;
    try { const rr = await window.sq.qr.renderSaved(b.dataset.slug, fmt); if (rr && rr.ok && rr.data_url) await window.sq.qr.download(rr.data_url, b.dataset.slug); } catch { }
    b.textContent = old; b.disabled = false;
  }));
  const arch = w.querySelector('[data-arch]');
  if (arch) arch.addEventListener('click', async () => {
    const ok = await dialog({ title: 'Archive QR', message: 'Stops resolving + drops from the gallery. Scan history is kept.', ok: 'Archive', danger: true });
    if (!ok) return;
    await window.sq.qr.archive(arch.dataset.arch); loadGallery();
  });
}
function bindBack() { const b = $('gwrap').querySelector('[data-back]'); if (b) b.addEventListener('click', () => loadGallery()); }

// ======================= TABS =======================
function setTab(tab, focusSlug) {
  document.querySelectorAll('#tabseg button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $('gen').hidden = tab !== 'gen';
  $('gallery').hidden = tab !== 'gallery';
  if (tab === 'gallery') loadGallery(focusSlug || null);
}

// ======================= inline modal (Electron webview has no window.prompt/confirm) =======================
function dialog({ title, message, input, ok, cancel, danger }) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:9999;';
    ov.innerHTML = `<div style="background:var(--bg-panel);border:1px solid var(--line-strong);border-radius:8px;padding:18px 20px;width:340px;max-width:90vw;">
      <div style="font-size:14px;color:var(--tx);font-weight:600;margin-bottom:${message || input ? '8' : '14'}px;">${esc(title || '')}</div>
      ${message ? `<div style="font-size:12px;color:var(--tx-dim);margin-bottom:${input ? '10' : '14'}px;line-height:1.5;">${esc(message)}</div>` : ''}
      ${input ? `<input id="_dlgIn" type="text" placeholder="${esc(input.placeholder || '')}" value="${esc(input.default || '')}" style="width:100%;background:var(--bg);border:1px solid var(--line-strong);color:var(--tx);font:inherit;font-size:13px;padding:8px 10px;border-radius:4px;outline:none;margin-bottom:14px;">` : ''}
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button id="_dlgCancel" style="background:transparent;border:1px solid var(--line-strong);color:var(--tx-muted);font:inherit;font-size:12px;padding:6px 14px;border-radius:3px;cursor:pointer;">${esc(cancel || 'Cancel')}</button>
        <button id="_dlgOk" style="background:${danger ? 'var(--bad-bg)' : 'var(--info-bg)'};border:1px solid ${danger ? 'var(--bad-line)' : 'var(--accent-soft)'};color:${danger ? 'var(--bad-fg)' : 'var(--accent)'};font:inherit;font-size:12px;padding:6px 14px;border-radius:3px;cursor:pointer;">${esc(ok || 'OK')}</button>
      </div></div>`;
    document.body.appendChild(ov);
    const inp = ov.querySelector('#_dlgIn'); if (inp) { inp.focus(); inp.select(); }
    const done = (val) => { ov.remove(); resolve(val); };
    ov.querySelector('#_dlgOk').addEventListener('click', () => done(input ? (inp.value.trim() || null) : true));
    ov.querySelector('#_dlgCancel').addEventListener('click', () => done(input ? null : false));
    ov.addEventListener('click', (e) => { if (e.target === ov) done(input ? null : false); });
    if (inp) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(inp.value.trim() || null); if (e.key === 'Escape') done(null); });
  });
}
function flashModal(msg) { dialog({ title: 'Error', message: msg, ok: 'OK', cancel: 'Dismiss' }); }

// ======================= INIT =======================
async function init() {
  document.querySelectorAll('#tabseg button').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('controls').addEventListener('click', onControlsClick);
  $('controls').addEventListener('input', onControlsInput);
  $('controls').addEventListener('change', (e) => { if (e.target.id === 'logoFile') onLogoFile(e); });
  $('railL').addEventListener('click', (e) => {
    const p = e.target.closest('[data-preset]'); if (p) return applyPreset(p.dataset.preset);
    if (e.target.closest('[data-random]')) { randomDesign(); buildControls(); return schedulePreview(); }
    if (e.target.id === 'saveKit') return saveKit();
    const k = e.target.closest('[data-kit]'); if (k) return applyKit(savedKits[Number(k.dataset.kit)].kit);
    const dk = e.target.closest('[data-delkit]'); if (dk) { savedKits.splice(Number(dk.dataset.delkit), 1); localStorage.setItem('qr-studio-kits', JSON.stringify(savedKits)); renderRail(); return; }
  });
  $('gwrap').addEventListener('click', onGalleryClick);
  $('dlPng').addEventListener('click', () => download('png'));
  $('dlSvg').addEventListener('click', () => download('svg'));
  $('saveTrack').addEventListener('click', saveAndTrack);
  // load engine option vocabularies (single source of truth), then build UI.
  const [pt, dopt] = await Promise.all([
    window.sq.qr.payloadTypes().catch(() => null),
    window.sq.qr.designOptions().catch(() => null),
  ]);
  if (pt && pt.ok) payloadTypes = pt.types || [];
  if (dopt && dopt.ok) designOpts = dopt;
  renderRail();
  buildControls();
  renderPreview();
}
init();
