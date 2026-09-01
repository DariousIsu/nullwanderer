'use strict';
/*
 * smoke_report_graphics.js — the report-graphics door (lib/report_graphics + lib/report_maps).
 *
 * The contract under test is the ANTI-FABRICATION posture: bad data fails NAMING the offender
 * (never silently dropped/interpolated), unknown geography is refused (never guessed), absence is
 * honest ("no data"), and ok:true stands only on files probed back from disk. Offline, no GPU.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const rg = require('../lib/report_graphics');
const maps = require('../lib/report_maps');

let okCount = 0, fail = 0;
function ok(name, cond) {
  if (cond) { okCount++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rg_smoke_'));
  const out = (n) => path.join(tmp, n);

  // ── golden path: grouped bar chart, negative value included ──────────────────────────────────
  const bar = await rg.render({
    kind: 'chart', chart: 'bar', title: 'Smoke topline', source: 'smoke', out: out('bar'),
    series: [
      { name: 'Yes', values: [{ label: 'Q1', value: 41 }, { label: 'Q2', value: 47.5 }] },
      { name: 'No', values: [{ label: 'Q1', value: 52 }, { label: 'Q2', value: -3 }] },
    ],
  });
  ok('bar chart renders (ok + svg on disk)', bar.ok && fs.existsSync(bar.path) && bar.probe.svgBytes > 500);
  ok('bar probe carries measured dims + item count', bar.ok && bar.probe.width === 960 && bar.probe.items === 4);
  ok('png rasterized and probed from its own IHDR', bar.ok && bar.png && bar.probe.png && bar.probe.png.width === 960 && bar.probe.png.bytes > 1000);
  ok('svg carries the real series + labels', bar.ok && (() => { const s = fs.readFileSync(bar.path, 'utf8'); return s.includes('Yes') && s.includes('Q2') && s.includes('Smoke topline'); })());

  // ── fabrication guards: bad data FAILS NAMING the offender ───────────────────────────────────
  const nan = await rg.render({ kind: 'chart', chart: 'bar', out: out('nan'), series: [{ values: [{ label: 'A', value: 1 }, { label: 'B', value: NaN }] }] });
  ok('NaN value → ok:false naming the exact datum', !nan.ok && /values\[1\]\.value/.test(nan.error));
  const misaligned = await rg.render({ kind: 'chart', chart: 'line', out: out('mis'), series: [{ values: [{ label: 'A', value: 1 }] }, { values: [{ label: 'B', value: 2 }] }] });
  ok('misaligned series categories → ok:false, no reorder', !misaligned.ok && /align/.test(misaligned.error));
  const empty = await rg.render({});
  ok('empty spec → ok:false, never a throw', !empty.ok && /kind/.test(empty.error));

  // ── maps: real geometry, exact keys, honest absence ──────────────────────────────────────────
  ok('state keys resolve exactly (postal/fips/name)', maps.stateFipsForKey('FL') === '12' && maps.stateFipsForKey('12') === '12' && maps.stateFipsForKey('Florida') === '12');
  ok('county "Name, ST" resolves via the census TSV', maps.countyFipsForKey('Broward, FL') === '12011' && maps.countyFipsForKey('12086') === '12086');
  ok('ambiguous bare county name is REFUSED (null)', maps.countyFipsForKey('Washington') === null);
  const badKey = await rg.render({ kind: 'map', map: 'states', out: out('bad'), values: [{ key: 'ZZ', value: 1 }] });
  ok('unknown region key → ok:false naming it', !badKey.ok && /"ZZ"/.test(badKey.error));
  const dupKey = await rg.render({ kind: 'map', map: 'states', out: out('dup'), values: [{ key: 'FL', value: 1 }, { key: 'Florida', value: 2 }] });
  ok('duplicate region (two spellings, one state) → ok:false', !dupKey.ok && /duplicates/.test(dupKey.error));
  const choro = await rg.render({ kind: 'map', map: 'states', mode: 'choropleth', out: out('choro'), values: [{ key: 'FL', value: 10 }, { key: 'TX', value: 30 }] });
  ok('states choropleth renders real boundaries', choro.ok && choro.probe.items === 2 && choro.probe.svgBytes > 50000);
  ok('absence is honest: unvalued states counted as "no data"', choro.ok && fs.readFileSync(choro.path, 'utf8').includes('no data (49)'));

  // ── orgchart + schematic ─────────────────────────────────────────────────────────────────────
  const org = await rg.render({ kind: 'orgchart', out: out('org'), root: { name: 'Root', title: 'Lead', children: [{ name: 'A' }, { name: 'B', children: [{ name: 'B1' }] }] } });
  ok('orgchart renders with every node', org.ok && org.probe.items === 4 && fs.readFileSync(org.path, 'utf8').includes('B1'));
  const cyc = await rg.render({ kind: 'schematic', out: out('cyc'), nodes: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }], edges: [{ from: 'x', to: 'y' }, { from: 'y', to: 'x' }] });
  ok('schematic cycle → ok:false naming a member', !cyc.ok && /cycle/.test(cyc.error));
  const flow = await rg.render({ kind: 'schematic', out: out('flow'), nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', shape: 'diamond' }], edges: [{ from: 'a', to: 'b', label: 'go' }] });
  ok('schematic renders nodes + labeled edge + arrow', flow.ok && (() => { const s = fs.readFileSync(flow.path, 'utf8'); return s.includes('polygon') && s.includes('marker-end') && s.includes('>go<'); })());

  // ── adversarial-review regressions (2026-09-01 panel, 16 confirmed) ──────────────────────────
  const dupCat = await rg.render({ kind: 'chart', chart: 'bar', out: out('dupcat'), series: [{ values: [{ label: 'Q1', value: 10 }, { label: 'Q1', value: 99 }] }] });
  ok('duplicate category label → ok:false naming it', !dupCat.ok && /"Q1"/.test(dupCat.error));
  ok('ambiguous "Richmond, VA" (city vs County) is REFUSED', maps.countyFipsForKey('Richmond, VA') === null && maps.countyFipsForKey('Richmond city, VA') === '51760' && maps.countyFipsForKey('Richmond County, VA') === '51159');
  const tiny = rg.composeSvg({ kind: 'chart', chart: 'bar', series: [{ values: [{ label: 'A', value: 0.0001 }, { label: 'B', value: 0.0004 }] }] });
  ok('small nonzero values never format as "0" (faithful decimals)', tiny.svg.includes('0.0004') && !/>0<\/text>.*>0<\/text>.*>0<\/text>/.test(tiny.svg));
  const frac = rg.composeSvg({ kind: 'chart', chart: 'hbar', series: [{ values: [{ label: 'A', value: 47.5 }] }] });
  ok('47.5 renders as 47.5, never rounded to 48', frac.svg.includes('47.5'));
  const hostile = await rg.render({ kind: 'chart', chart: 'bar', out: out('hostile'), format: { suffix: ' P&L<' }, series: [{ values: [{ label: 'A', value: 5 }, { label: 'B', value: 9 }] }] });
  ok('hostile format prefix/suffix → well-formed SVG (png rasterizes)', hostile.ok && hostile.png && !hostile.probe.pngError);
  const myRoot = { name: 'Root', children: [{ name: 'Kid' }] };
  await rg.render({ kind: 'orgchart', out: out('mut'), root: myRoot });
  ok('orgchart never mutates the caller\'s data', !('_cx' in myRoot) && !('_cx' in myRoot.children[0]));
  const mixed = await rg.render({ kind: 'map', map: 'states', mode: 'bubble', out: out('mixed'), values: [{ key: 'FL', value: -50 }, { key: 'TX', value: 50 }] });
  ok('mixed-sign bubbles: sign is visible + legend says |value|', mixed.ok && (() => { const s = fs.readFileSync(mixed.path, 'utf8'); return s.includes('negative values') && s.includes('|value|'); })());
  const scoped = await rg.render({ kind: 'map', map: 'states', state: 'FL', labels: 'keys', out: out('scoped'), values: [{ key: 'FL', value: 10 }] });
  ok('scoped-map labels: halo scales with the font (no raw 2.5 halo)', scoped.ok && (() => {
    const m = /font-size="([\d.]+)"[^>]*stroke-width="([\d.]+)"/.exec(fs.readFileSync(scoped.path, 'utf8'));
    return m && Math.abs(parseFloat(m[2]) / parseFloat(m[1]) - 2.5 / 11) < 0.01;
  })());
  const p1 = await rg.render({ kind: 'chart', chart: 'bar', title: 'same title', series: [{ values: [{ label: 'A', value: 1 }] }] });
  const p2 = await rg.render({ kind: 'chart', chart: 'bar', title: 'same title', series: [{ values: [{ label: 'A', value: 2 }] }] });
  ok('same-title default outputs never collide', p1.ok && p2.ok && p1.path !== p2.path);
  try { fs.rmSync(p1.path, { force: true }); fs.rmSync(p1.png || '', { force: true }); fs.rmSync(p2.path, { force: true }); fs.rmSync(p2.png || '', { force: true }); } catch {}

  // ── themes + the door's registration ─────────────────────────────────────────────────────────
  const dark = await rg.render({ kind: 'chart', chart: 'hbar', theme: 'dark', out: out('dark'), series: [{ values: [{ label: 'A', value: 5 }] }] });
  ok('dark theme renders on the house ground', dark.ok && fs.readFileSync(dark.path, 'utf8').includes('#0d0d10'));
  ok('report-graphics door registered in capability manifest', (() => {
    const m = require('../lib/capability_manifest').manifest({ now: Date.now() });
    return m.some(e => /report graphics/i.test(e.name));
  })());
  ok('US-maps door listed only on MEASURED atlas presence', (() => {
    const m = require('../lib/capability_manifest').manifest({ now: Date.now() + 1 });
    return m.some(e => /US report maps/i.test(e.name)) === maps.available();
  })());

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${okCount} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('SMOKE THREW:', e.stack); process.exit(1); });
