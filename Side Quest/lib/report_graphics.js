'use strict';
/**
 * lib/report_graphics.js — REPORT GRAPHICS door for the document road: charts, maps, org charts,
 * and schematics as deterministic SVG (+PNG), from grounded data only.
 *
 * The law this module embodies (same law as the cutting room's assemble(): "a model never touches
 * an ffmpeg flag"): A MODEL NEVER DRAWS A BAR. Cognition authors a declarative SPEC whose numbers
 * and names come from the DB; this engine lays it out and draws it. Diffusion (the image suite) is
 * for illustrations — anything data-bearing renders HERE, where fabrication is impossible by
 * construction:
 *   - every datum is validated (finite numbers, resolvable region keys); a bad/unknown datum FAILS
 *     the render naming it — no silent drops, no interpolation, no guessed geography;
 *   - map geometry is real US Census boundaries (lib/report_maps → us-atlas, pre-projected);
 *   - absence is honest: regions without data get a distinct "no data" fill, never zero.
 *
 * render(spec) → { ok, path(svg), png(path|null), probe } | { ok:false, error }. Fail-soft, and
 * the say-do gate lives IN the tool: ok:true means files on disk whose bytes/dimensions were read
 * back (PNG probed from its own IHDR), never assumed.
 *
 * spec = { kind:'chart'|'map'|'orgchart'|'schematic', title?, source?, theme:'light'|'dark',
 *          out?, png?:true, ...kind fields } — see each composer below for its fields.
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data', 'report_graphics');
const FONT = 'Segoe UI, Arial, sans-serif';
const EST = 0.55; // estimated glyph width / font-size for label sizing (no DOM to measure with)

const THEMES = {
  light: { bg: '#ffffff', ink: '#171720', muted: '#6b6b76', grid: '#e7e7ec', frame: '#d9d9e0',
    noData: '#f1f1f4', ramp: ['#dbeafe', '#1d4ed8'],
    accents: ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#0891b2'] },
  dark: { bg: '#0d0d10', ink: '#f2f2f6', muted: '#9a9aa5', grid: '#26262e', frame: '#33333c',
    noData: '#1a1a20', ramp: ['#1e293b', '#60a5fa'],
    accents: ['#3b82f6', '#ec4899', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4'] },
};

// ── small pure helpers ──────────────────────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const textW = (s, fontSize) => String(s).length * fontSize * EST;
function ellipsize(s, maxPx, fontSize) {
  s = String(s);
  if (textW(s, fontSize) <= maxPx) return s;
  const n = Math.max(1, Math.floor(maxPx / (fontSize * EST)) - 1);
  return s.slice(0, n) + '…';
}
// Faithful by construction: auto-decimals come from the value's own magnitude, so a nonzero datum
// NEVER formats as "0" and 47.5 never rounds to "48" (rendering a number the data doesn't hold is
// fabrication). Explicit format.decimals still wins; trailing zeros are trimmed.
function fmtVal(v, format) {
  const f = format || {};
  const d = Number.isFinite(f.decimals) ? f.decimals
    : (v === 0 || Number.isInteger(v)) ? 0
    : Math.min(6, Math.max(1, 1 - Math.floor(Math.log10(Math.abs(v)))));
  const body = Math.abs(v) >= 1000
    ? v.toLocaleString('en-US', { maximumFractionDigits: d })
    : v.toFixed(d).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return `${f.prefix || ''}${body}${f.suffix || ''}`;
}
// the standard nice-ticks algorithm: a readable axis covering [min,max] (0 always included for bars)
function niceTicks(min, max, count = 5) {
  if (min === max) { min -= Math.abs(min) * 0.1 || 1; max += Math.abs(max) * 0.1 || 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= count) || 10 * mag;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let t = lo; t <= hi + step / 2; t += step) ticks.push(Math.abs(t) < step / 1e6 ? 0 : t);
  return { lo, hi, ticks };
}
// validation that NAMES the offender — the anti-fabrication posture (fail loud, never patch data)
function needNum(v, where) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${where}: value must be a finite number (got ${JSON.stringify(v)})`);
  return v;
}
function needStr(v, where) {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${where}: a non-empty label is required`);
  return v.trim();
}

// shared chrome: title above, source line below; returns { header, footer, top, bottom }
function chrome(W, H, spec, T) {
  let top = 16, header = '';
  if (spec.title) {
    top = 44;
    header = `<text x="${W / 2}" y="27" text-anchor="middle" font-size="17" font-weight="600" fill="${T.ink}" font-family="${FONT}">${esc(ellipsize(spec.title, W - 40, 17))}</text>`;
  }
  let bottom = H - 12, footer = '';
  if (spec.source) {
    footer = `<text x="${W - 14}" y="${H - 10}" text-anchor="end" font-size="10" fill="${T.muted}" font-family="${FONT}">${esc(ellipsize(spec.source, W - 40, 10))}</text>`;
    bottom = H - 26;
  }
  return { header, footer, top, bottom };
}
function legend(seriesNames, T, x, y) {
  let out = '', cx = x;
  seriesNames.forEach((name, i) => {
    const c = T.accents[i % T.accents.length];
    out += `<rect x="${cx}" y="${y - 8}" width="10" height="10" rx="2" fill="${c}"/>` +
      `<text x="${cx + 15}" y="${y + 1}" font-size="11" fill="${T.ink}" font-family="${FONT}">${esc(name)}</text>`;
    cx += 15 + textW(name, 11) + 18;
  });
  return out;
}

/* ── CHART: { chart:'bar'|'hbar'|'line', series:[{ name?, values:[{label, value}] }], format? }
 *    Categories are series[0]'s labels; every further series must carry the SAME labels in the
 *    same order (mismatch = fail naming it — aligned data is the caller's statement, we never
 *    reorder or interpolate). Negative values supported (baseline at 0). */
function composeChart(spec, T) {
  const kindC = ['bar', 'hbar', 'line'].includes(spec.chart) ? spec.chart : null;
  if (!kindC) throw new Error(`chart: 'chart' must be bar|hbar|line (got ${JSON.stringify(spec.chart)})`);
  const series = Array.isArray(spec.series) ? spec.series : [];
  if (!series.length) throw new Error('chart: series[] is required');
  if (series.length > 6) throw new Error('chart: at most 6 series stay legible');
  const cats = (series[0].values || []).map((v, i) => needStr(v && v.label, `series[0].values[${i}].label`));
  if (!cats.length) throw new Error('chart: series[0].values[] is empty');
  if (cats.length > 500) throw new Error(`chart: ${cats.length} categories — over 500 is not a legible chart; aggregate first`);
  { const seen = new Set(); for (const c of cats) { if (seen.has(c)) throw new Error(`chart: duplicate category label "${c}" — two bars with one name are indistinguishable; disambiguate the labels`); seen.add(c); } }
  series.forEach((s, si) => {
    const vals = s.values || [];
    if (vals.length !== cats.length) throw new Error(`chart: series[${si}] has ${vals.length} values, expected ${cats.length} (categories must align)`);
    vals.forEach((v, i) => {
      needNum(v && v.value, `series[${si}].values[${i}].value`);
      if (needStr(v.label, `series[${si}].values[${i}].label`) !== cats[i])
        throw new Error(`chart: series[${si}].values[${i}].label "${v.label}" ≠ category "${cats[i]}" — categories must align across series`);
    });
  });
  // reduce, never spread — a spread over a large array overflows the call stack
  const ext = series.reduce((a, s) => s.values.reduce((a2, v) => ({ min: Math.min(a2.min, v.value), max: Math.max(a2.max, v.value) }), a), { min: 0, max: 0 });
  const { lo, hi, ticks } = niceTicks(ext.min, ext.max);
  const multi = series.length > 1;

  const W = spec.width || 960, H = spec.height || 540;
  const ch = chrome(W, H, spec, T);
  const legendH = multi ? 24 : 0;
  const g = []; // svg body
  const fmt = (v) => fmtVal(v, spec.format);
  const ftxt = (v) => esc(fmt(v)); // fmt carries caller strings (prefix/suffix) — escape at every direct text site

  if (kindC === 'hbar') {
    const labelW = Math.min(240, cats.reduce((a, c) => Math.max(a, textW(c, 12)), 0) + 14);
    const px = { l: 20 + labelW, r: 70, t: ch.top + legendH + 8, b: H - ch.bottom + 6 };
    const iw = W - px.l - px.r, ihh = ch.bottom - px.t - 8;
    const x = (v) => px.l + ((v - lo) / (hi - lo)) * iw;
    const rowH = ihh / cats.length, barH = Math.max(4, (rowH * 0.72) / series.length);
    for (const t of ticks) g.push(`<line x1="${x(t)}" y1="${px.t}" x2="${x(t)}" y2="${px.t + ihh}" stroke="${t === 0 ? T.muted : T.grid}" stroke-width="1"/>`,
      `<text x="${x(t)}" y="${px.t + ihh + 16}" text-anchor="middle" font-size="10" fill="${T.muted}" font-family="${FONT}">${ftxt(t)}</text>`);
    cats.forEach((c, ci) => {
      const cy = px.t + ci * rowH + rowH / 2;
      g.push(`<text x="${px.l - 8}" y="${cy + 4}" text-anchor="end" font-size="12" fill="${T.ink}" font-family="${FONT}">${esc(ellipsize(c, labelW - 8, 12))}</text>`);
      series.forEach((s, si) => {
        const v = s.values[ci].value;
        const y0 = cy - (series.length * barH) / 2 + si * barH;
        const bx = Math.min(x(0), x(v)), bw = Math.abs(x(v) - x(0));
        g.push(`<rect x="${bx}" y="${y0}" width="${Math.max(bw, 0.5)}" height="${barH - 1}" rx="2" fill="${T.accents[si % T.accents.length]}"><title>${esc(`${c}${multi ? ' · ' + (s.name || 'series ' + (si + 1)) : ''}: ${fmt(v)}`)}</title></rect>`);
        if (bw > textW(fmt(v), 10) + 8) g.push(`<text x="${v >= 0 ? x(v) - 4 : x(v) + 4}" y="${y0 + barH / 2 + 3}" text-anchor="${v >= 0 ? 'end' : 'start'}" font-size="10" fill="${T.bg}" font-family="${FONT}">${ftxt(v)}</text>`);
        else g.push(`<text x="${v >= 0 ? x(v) + 4 : x(v) - 4}" y="${y0 + barH / 2 + 3}" text-anchor="${v >= 0 ? 'start' : 'end'}" font-size="10" fill="${T.muted}" font-family="${FONT}">${ftxt(v)}</text>`);
      });
    });
  } else {
    // vertical bar & line share the frame
    const yAxisW = Math.max(...ticks.map(t => textW(fmt(t), 10))) + 16;
    const px = { l: 20 + yAxisW, r: 24, t: ch.top + legendH + 8 };
    const xLabelH = 22;
    const iw = W - px.l - px.r, ihh = ch.bottom - px.t - xLabelH;
    const y = (v) => px.t + ihh - ((v - lo) / (hi - lo)) * ihh;
    for (const t of ticks) g.push(`<line x1="${px.l}" y1="${y(t)}" x2="${px.l + iw}" y2="${y(t)}" stroke="${t === 0 ? T.muted : T.grid}" stroke-width="1"/>`,
      `<text x="${px.l - 6}" y="${y(t) + 3.5}" text-anchor="end" font-size="10" fill="${T.muted}" font-family="${FONT}">${ftxt(t)}</text>`);
    const slot = iw / cats.length;
    cats.forEach((c, ci) => {
      const cx = px.l + ci * slot + slot / 2;
      g.push(`<text x="${cx}" y="${px.t + ihh + 16}" text-anchor="middle" font-size="11" fill="${T.ink}" font-family="${FONT}">${esc(ellipsize(c, slot - 6, 11))}</text>`);
    });
    if (kindC === 'bar') {
      const barW = Math.max(3, (slot * 0.68) / series.length);
      cats.forEach((c, ci) => series.forEach((s, si) => {
        const v = s.values[ci].value;
        const bx = px.l + ci * slot + slot / 2 - (series.length * barW) / 2 + si * barW;
        const by = Math.min(y(0), y(v)), bh = Math.abs(y(v) - y(0));
        g.push(`<rect x="${bx}" y="${by}" width="${barW - 1}" height="${Math.max(bh, 0.5)}" rx="2" fill="${T.accents[si % T.accents.length]}"><title>${esc(`${c}${multi ? ' · ' + (s.name || 'series ' + (si + 1)) : ''}: ${fmt(v)}`)}</title></rect>`);
        if (!multi && barW > textW(fmt(v), 10)) g.push(`<text x="${bx + barW / 2}" y="${v >= 0 ? by - 4 : by + bh + 12}" text-anchor="middle" font-size="10" fill="${T.muted}" font-family="${FONT}">${ftxt(v)}</text>`);
      }));
    } else {
      series.forEach((s, si) => {
        const c = T.accents[si % T.accents.length];
        const pts = s.values.map((v, ci) => `${px.l + ci * slot + slot / 2},${y(v.value)}`);
        if (pts.length > 1) g.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${c}" stroke-width="2.2" stroke-linejoin="round"/>`);
        s.values.forEach((v, ci) => g.push(`<circle cx="${px.l + ci * slot + slot / 2}" cy="${y(v.value)}" r="3.4" fill="${c}"><title>${esc(`${cats[ci]}${multi ? ' · ' + (s.name || 'series ' + (si + 1)) : ''}: ${fmt(v.value)}`)}</title></circle>`));
      });
    }
  }
  if (multi) g.push(legend(series.map((s, i) => s.name || `series ${i + 1}`), T, 24, ch.top + 12));
  return { W, H, body: g.join(''), chrome: ch, items: cats.length * series.length };
}

/* ── ORGCHART: { root: { name, title?, children:[…] } } — a tidy tree (leaf-slot layout). */
function composeOrgchart(spec, T) {
  if (!spec.root || typeof spec.root !== 'object') throw new Error('orgchart: root node is required');
  let root; // layout annotates nodes (_cx/_y) — work on a COPY, never mutate the caller's data
  try { root = JSON.parse(JSON.stringify(spec.root)); }
  catch { throw new Error('orgchart: root must be plain JSON-serializable data (no cycles)'); }
  const BOX_W = 168, BOX_H = 50, HGAP = 14, VGAP = 46;
  let count = 0, depthMax = 0;
  (function validate(n, pth, depth) {
    needStr(n.name, `orgchart node at ${pth}.name`);
    count++; if (count > 400) throw new Error('orgchart: over 400 nodes — too many for one legible chart; split it');
    depthMax = Math.max(depthMax, depth);
    (n.children || []).forEach((c, i) => validate(c, `${pth}.children[${i}]`, depth + 1));
  })(root, 'root', 0);
  const leaves = (n) => (n.children && n.children.length) ? n.children.reduce((a, c) => a + leaves(c), 0) : 1;
  const totalLeaves = leaves(root);
  const W = Math.max(spec.width || 0, totalLeaves * (BOX_W + HGAP) + 40);
  const ch = chrome(W, 0, { title: spec.title }, T); // height computed below
  const H0 = ch.top + 10, H = H0 + (depthMax + 1) * (BOX_H + VGAP) - VGAP + (spec.source ? 34 : 18);
  const ch2 = chrome(W, H, spec, T);
  const g = [];
  let cursor = 0;
  (function place(n, depth) {
    const myLeaves = leaves(n);
    const x0 = 20 + cursor * (BOX_W + HGAP);
    const cx = x0 + (myLeaves * (BOX_W + HGAP) - HGAP) / 2;
    const y = H0 + depth * (BOX_H + VGAP);
    n._cx = cx; n._y = y;
    if (n.children && n.children.length) {
      for (const c of n.children) place(c, depth + 1);
      const railY = y + BOX_H + VGAP / 2;
      g.push(`<line x1="${cx}" y1="${y + BOX_H}" x2="${cx}" y2="${railY}" stroke="${T.frame}" stroke-width="1.4"/>`);
      const xs = n.children.map(c => c._cx);
      g.push(`<line x1="${Math.min(...xs)}" y1="${railY}" x2="${Math.max(...xs)}" y2="${railY}" stroke="${T.frame}" stroke-width="1.4"/>`);
      for (const c of n.children) g.push(`<line x1="${c._cx}" y1="${railY}" x2="${c._cx}" y2="${c._y}" stroke="${T.frame}" stroke-width="1.4"/>`);
    } else cursor++;
    const bx = cx - BOX_W / 2;
    g.push(`<rect x="${bx}" y="${y}" width="${BOX_W}" height="${BOX_H}" rx="7" fill="${T.bg}" stroke="${depth === 0 ? T.accents[0] : T.frame}" stroke-width="${depth === 0 ? 1.8 : 1.2}"/>`,
      `<text x="${cx}" y="${y + (n.title ? 21 : 29)}" text-anchor="middle" font-size="12.5" font-weight="600" fill="${T.ink}" font-family="${FONT}">${esc(ellipsize(n.name, BOX_W - 14, 12.5))}<title>${esc(n.name)}</title></text>`);
    if (n.title) g.push(`<text x="${cx}" y="${y + 37}" text-anchor="middle" font-size="10.5" fill="${T.muted}" font-family="${FONT}">${esc(ellipsize(n.title, BOX_W - 14, 10.5))}</text>`);
  })(root, 0);
  return { W, H, body: g.join(''), chrome: ch2, items: count };
}

/* ── SCHEMATIC: { nodes:[{id,label,shape:'box'|'pill'|'diamond'}], edges:[{from,to,label?}],
 *    direction:'LR'|'TB' } — a layered DAG (longest-path layering; a cycle FAILS naming a member). */
function composeSchematic(spec, T) {
  const nodes = Array.isArray(spec.nodes) ? spec.nodes : [];
  const edges = Array.isArray(spec.edges) ? spec.edges : [];
  if (!nodes.length) throw new Error('schematic: nodes[] is required');
  if (nodes.length > 120) throw new Error('schematic: over 120 nodes — split it');
  const byId = new Map();
  nodes.forEach((n, i) => {
    const id = needStr(n.id, `nodes[${i}].id`);
    needStr(n.label, `nodes[${i}].label`);
    if (byId.has(id)) throw new Error(`schematic: duplicate node id "${id}"`);
    byId.set(id, n);
  });
  edges.forEach((e, i) => {
    if (!byId.has(e.from)) throw new Error(`schematic: edges[${i}].from "${e.from}" is not a node`);
    if (!byId.has(e.to)) throw new Error(`schematic: edges[${i}].to "${e.to}" is not a node`);
  });
  // longest-path layering by relaxation; more than n rounds of change = a cycle
  const layer = new Map(nodes.map(n => [n.id, 0]));
  for (let round = 0; ; round++) {
    let changed = null;
    for (const e of edges) {
      const want = layer.get(e.from) + 1;
      if (layer.get(e.to) < want) { layer.set(e.to, want); changed = e.to; }
    }
    if (!changed) break;
    if (round > nodes.length + 1) throw new Error(`schematic: cycle detected involving "${changed}" — a layered schematic needs acyclic edges`);
  }
  const layers = [];
  for (const n of nodes) { const L = layer.get(n.id); (layers[L] = layers[L] || []).push(n); }
  const BOX_W = 150, BOX_H = 44, MAIN_GAP = 84, CROSS_GAP = 18;
  const LR = (spec.direction || 'LR') === 'LR';
  const maxPerLayer = Math.max(...layers.map(l => l.length));
  const mainSpan = layers.length * (LR ? BOX_W : BOX_H) + (layers.length - 1) * MAIN_GAP;
  const crossSpan = maxPerLayer * ((LR ? BOX_H : BOX_W) + CROSS_GAP) - CROSS_GAP;
  const W = (LR ? mainSpan : crossSpan) + 60;
  const preH = (LR ? crossSpan : mainSpan) + 60;
  const ch = chrome(W, 0, { title: spec.title }, T);
  const H = ch.top + preH + (spec.source ? 26 : 6);
  const ch2 = chrome(W, H, spec, T);
  const pos = new Map();
  layers.forEach((ns, li) => ns.forEach((n, ni) => {
    const main = 30 + li * ((LR ? BOX_W : BOX_H) + MAIN_GAP);
    const crossTotal = ns.length * ((LR ? BOX_H : BOX_W) + CROSS_GAP) - CROSS_GAP;
    const cross = 30 + ((LR ? crossSpan : crossSpan) - crossTotal) / 2 + ni * ((LR ? BOX_H : BOX_W) + CROSS_GAP);
    pos.set(n.id, LR ? { x: main, y: ch.top + cross } : { x: 30 + cross, y: ch.top + main });
  }));
  const g = [`<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill="${T.muted}"/></marker></defs>`];
  for (const e of edges) {
    const a = pos.get(e.from), b = pos.get(e.to);
    const [x1, y1] = LR ? [a.x + BOX_W, a.y + BOX_H / 2] : [a.x + BOX_W / 2, a.y + BOX_H];
    const [x2, y2] = LR ? [b.x, b.y + BOX_H / 2] : [b.x + BOX_W / 2, b.y];
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const d = LR ? `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}` : `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
    g.push(`<path d="${d}" fill="none" stroke="${T.muted}" stroke-width="1.5" marker-end="url(#arr)"/>`);
    if (e.label) g.push(`<text x="${mx}" y="${my - 4}" text-anchor="middle" font-size="10" fill="${T.muted}" font-family="${FONT}" stroke="${T.bg}" stroke-width="3" paint-order="stroke">${esc(e.label)}</text>`);
  }
  for (const n of nodes) {
    const p = pos.get(n.id);
    const cx = p.x + BOX_W / 2, cy = p.y + BOX_H / 2;
    if (n.shape === 'diamond') g.push(`<polygon points="${cx},${p.y - 6} ${p.x + BOX_W + 8},${cy} ${cx},${p.y + BOX_H + 6} ${p.x - 8},${cy}" fill="${T.bg}" stroke="${T.accents[1]}" stroke-width="1.4"/>`);
    else g.push(`<rect x="${p.x}" y="${p.y}" width="${BOX_W}" height="${BOX_H}" rx="${n.shape === 'pill' ? BOX_H / 2 : 7}" fill="${T.bg}" stroke="${n.shape === 'pill' ? T.accents[2] : T.accents[0]}" stroke-width="1.4"/>`);
    g.push(`<text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="11.5" fill="${T.ink}" font-family="${FONT}">${esc(ellipsize(n.label, BOX_W - 12, 11.5))}<title>${esc(n.label)}</title></text>`);
  }
  return { W, H, body: g.join(''), chrome: ch2, items: nodes.length };
}

/* ── MAP: { map:'states'|'counties', mode:'choropleth'|'bubble', values:[{key, value}],
 *    state? (scope a counties map to one state), labels:'none'|'keys', format? }
 *    Keys resolve EXACTLY (postal/FIPS/full state name; counties: 5-digit FIPS or "Name, ST") via
 *    lib/report_maps; an unknown key fails the render naming it. No-data regions get the neutral
 *    fill and the legend says so. */
function composeMap(spec, T) {
  const maps = require('./report_maps');
  if (!maps.available()) throw new Error('map: us-atlas geometry not installed (npm install us-atlas)');
  const level = spec.map === 'counties' ? 'counties' : spec.map === 'states' ? 'states' : null;
  if (!level) throw new Error(`map: 'map' must be states|counties (got ${JSON.stringify(spec.map)})`);
  const mode = spec.mode === 'bubble' ? 'bubble' : 'choropleth';
  const rows = Array.isArray(spec.values) ? spec.values : [];
  if (!rows.length) throw new Error('map: values[] is required');

  let feats = level === 'states' ? maps.states() : maps.counties();
  let scopeFips = null;
  if (spec.state) {
    scopeFips = maps.stateFipsForKey(spec.state);
    if (!scopeFips) throw new Error(`map: unknown state "${spec.state}" — use postal, 2-digit FIPS, or the full name`);
    if (level === 'counties') feats = feats.filter(f => f.id.startsWith(scopeFips));
    else feats = feats.filter(f => f.id === scopeFips);
  }
  const byId = new Map(feats.map(f => [f.id, f]));
  const valById = new Map();
  rows.forEach((r, i) => {
    const fips = level === 'states' ? maps.stateFipsForKey(r && r.key) : maps.countyFipsForKey(r && r.key);
    if (!fips) throw new Error(`map: values[${i}].key "${r && r.key}" does not resolve to a real ${level === 'states' ? 'state' : 'county'} — refusing to guess (counties take 5-digit FIPS or "Name, ST")`);
    if (!byId.has(fips)) throw new Error(`map: values[${i}].key "${r.key}" (${fips}) is outside the mapped scope${level === 'counties' && !spec.state ? ' — note the key table and the atlas differ in county vintage (CT planning regions vs legacy counties); use the 5-digit FIPS the atlas draws' : ''}`);
    if (valById.has(fips)) throw new Error(`map: values[${i}].key "${r.key}" duplicates ${fips}`);
    valById.set(fips, needNum(r.value, `values[${i}].value`));
  });
  const vals = [...valById.values()];
  const vMin = Math.min(...vals), vMax = Math.max(...vals);
  const lerp = (a, b, t) => Math.round(a + (b - a) * t);
  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const [r0, g0, b0] = hex(T.ramp[0]), [r1, g1, b1] = hex(T.ramp[1]);
  const colorFor = (v) => {
    const t = vMax === vMin ? 0.6 : (v - vMin) / (vMax - vMin);
    return `rgb(${lerp(r0, r1, t)},${lerp(g0, g1, t)},${lerp(b0, b1, t)})`;
  };
  const fmt = (v) => fmtVal(v, spec.format);
  const ftxt = (v) => esc(fmt(v)); // fmt carries caller strings (prefix/suffix) — escape at direct text sites

  // view: full US, or zoom to the scoped features' bbox
  const vb = (scopeFips || level === 'counties' && spec.state) ? maps.bboxOf(feats) : { x: 0, y: 0, ...maps.VIEW };
  const W = spec.width || 960;
  const mapH = W * (vb.height / vb.width);
  const ch0 = chrome(W, 0, { title: spec.title }, T);
  const legendH = 44;
  const H = ch0.top + mapH + legendH + (spec.source ? 22 : 4);
  const ch = chrome(W, H, spec, T);
  const g = [`<g transform="translate(0,${ch.top}) scale(${W / vb.width}) translate(${-vb.x},${-vb.y})">`];
  for (const f of feats) {
    const has = valById.has(f.id);
    const fill = has && mode === 'choropleth' ? colorFor(valById.get(f.id)) : T.noData;
    const tip = has ? `${f.name}: ${fmt(valById.get(f.id))}` : `${f.name}: no data`;
    g.push(`<path d="${f.path}" fill="${fill}" stroke="${T.frame}" stroke-width="0.7" vector-effect="non-scaling-stroke"><title>${esc(tip)}</title></path>`);
  }
  const hasNeg = vals.some(v => v < 0);
  if (mode === 'bubble') {
    const rMax = 22 * (vb.width / W); // constant on-screen size under the zoom transform
    const vAbsMax = vals.reduce((a, v) => Math.max(a, Math.abs(v)), 0) || 1;
    for (const [fips, v] of valById) {
      const f = byId.get(fips);
      if (!f.centroid) continue;
      const r = Math.max(3 * (vb.width / W), Math.sqrt(Math.abs(v) / vAbsMax) * rMax);
      const c = v < 0 ? T.accents[1] : T.accents[0]; // sign is DATA — a negative bubble must not look positive
      g.push(`<circle cx="${f.centroid.x}" cy="${f.centroid.y}" r="${r}" fill="${c}" fill-opacity="0.55" stroke="${c}" stroke-width="1" vector-effect="non-scaling-stroke"><title>${esc(`${f.name}: ${fmt(v)}`)}</title></circle>`);
    }
  }
  if (spec.labels === 'keys' && level === 'states') {
    const K = maps.keys();
    // one map-unit factor for EVERYTHING (font, halo, baseline) so labels survive the zoom
    // transform intact — a compensated font beside an uncompensated halo buries the glyphs
    const lm = vb.width / 975;
    for (const [fips] of valById) {
      const f = byId.get(fips);
      if (f.centroid) g.push(`<text x="${f.centroid.x}" y="${f.centroid.y + 3 * lm}" text-anchor="middle" font-size="${11 * lm}" fill="${T.ink}" font-family="${FONT}" stroke="${T.bg}" stroke-width="${2.5 * lm}" paint-order="stroke">${esc(K.fipsToPostal[fips.slice(0, 2)] || fips)}</text>`);
    }
  }
  g.push('</g>');
  // legend: gradient min→max (choropleth) or note (bubble) + the honest no-data swatch
  const ly = ch.top + mapH + 26;
  if (mode === 'choropleth') {
    g.push(`<defs><linearGradient id="ramp" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${T.ramp[0]}"/><stop offset="1" stop-color="${T.ramp[1]}"/></linearGradient></defs>`,
      `<rect x="24" y="${ly - 10}" width="160" height="10" rx="2" fill="url(#ramp)"/>`,
      `<text x="24" y="${ly + 14}" font-size="10" fill="${T.muted}" font-family="${FONT}">${ftxt(vMin)}</text>`,
      `<text x="184" y="${ly + 14}" text-anchor="end" font-size="10" fill="${T.muted}" font-family="${FONT}">${ftxt(vMax)}</text>`);
  } else {
    g.push(`<circle cx="30" cy="${ly - 5}" r="7" fill="${T.accents[0]}" fill-opacity="0.55" stroke="${T.accents[0]}"/>`,
      `<text x="44" y="${ly - 1}" font-size="10.5" fill="${T.muted}" font-family="${FONT}">bubble area ∝ |value| (${ftxt(vMin)} – ${ftxt(vMax)})</text>`);
    if (hasNeg) g.push(`<circle cx="${W / 2 - 60}" cy="${ly - 5}" r="7" fill="${T.accents[1]}" fill-opacity="0.55" stroke="${T.accents[1]}"/>`,
      `<text x="${W / 2 - 46}" y="${ly - 1}" font-size="10.5" fill="${T.muted}" font-family="${FONT}">negative values</text>`);
  }
  g.push(`<rect x="${W - 210}" y="${ly - 12}" width="12" height="12" rx="2" fill="${T.noData}" stroke="${T.frame}"/>`,
    `<text x="${W - 193}" y="${ly - 2}" font-size="10.5" fill="${T.muted}" font-family="${FONT}">no data (${feats.length - valById.size})</text>`);
  return { W, H, body: g.join(''), chrome: ch, items: valById.size };
}

// ── the door ────────────────────────────────────────────────────────────────────────────────────
const COMPOSERS = { chart: composeChart, orgchart: composeOrgchart, schematic: composeSchematic, map: composeMap };

// pure core: spec → { svg, width, height, items } (throws on invalid data — render() wraps)
function composeSvg(spec) {
  const s = spec || {};
  const composer = COMPOSERS[s.kind];
  if (!composer) throw new Error(`kind must be one of ${Object.keys(COMPOSERS).join('|')} (got ${JSON.stringify(s.kind)})`);
  const T = THEMES[s.theme === 'dark' ? 'dark' : 'light'];
  const { W, H, body, chrome: ch, items } = composer(s, T);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${Math.ceil(H)}" width="${W}" height="${Math.ceil(H)}" font-family="${FONT}">` +
    `<rect x="0" y="0" width="${W}" height="${Math.ceil(H)}" fill="${T.bg}"/>` + ch.header + body + ch.footer + '</svg>';
  return { svg, width: W, height: Math.ceil(H), items };
}

function _pngDims(buf) { // PNG IHDR: width/height as big-endian u32 at offsets 16/20
  if (!buf || buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/*
 * render(spec) — compose, write SVG (+PNG via resvg), then PROBE the artifacts before claiming ok.
 * PNG degrade is honest: if the rasterizer is unavailable/fails, ok:true still stands on the real
 * SVG with png:null and pngError naming why (SVG embeds directly in canvas/HTML docs; PNG is for
 * docx). ok:false only when there is nothing real on disk.
 */
async function render(spec) {
  try {
    const s = spec || {};
    const { svg, width, height, items } = composeSvg(s);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const slug = String(s.title || s.kind || 'graphic').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'graphic';
    // default paths are unique BY CONSTRUCTION (same-ms submissions must not truncate each other);
    // an explicit s.out is the caller's chosen destination and overwrites deliberately.
    let base;
    if (s.out) base = String(s.out).replace(/\.(svg|png)$/i, '');
    else {
      base = path.join(OUT_DIR, `${slug}_${Date.now()}`);
      for (let n = 2; fs.existsSync(base + '.svg'); n++) base = path.join(OUT_DIR, `${slug}_${Date.now()}_${n}`);
    }
    const svgPath = base + '.svg';
    fs.writeFileSync(svgPath, svg, 'utf8');
    const svgBytes = fs.statSync(svgPath).size;
    if (!(svgBytes > 0)) return { ok: false, error: 'svg write produced an empty file' };

    let pngPath = null, pngProbe = null, pngError = null;
    if (s.png !== false) {
      try {
        const { Resvg } = require('@resvg/resvg-js');
        const buf = new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: 'Segoe UI' } }).render().asPng();
        pngPath = base + '.png';
        fs.writeFileSync(pngPath, buf);
        pngProbe = _pngDims(fs.readFileSync(pngPath)); // read BACK — the say-do gate
        if (!pngProbe) { pngError = 'png failed verification (bad IHDR)'; fs.rmSync(pngPath, { force: true }); pngPath = null; }
        else pngProbe.bytes = fs.statSync(pngPath).size;
      } catch (e) { pngError = String(e && e.message || e); pngPath = null; pngProbe = null; }
    }
    return {
      ok: true, path: svgPath, png: pngPath,
      probe: { kind: s.kind, width, height, items, svgBytes, png: pngProbe, ...(pngError ? { pngError } : {}) },
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

module.exports = { render, composeSvg, THEMES, OUT_DIR };
