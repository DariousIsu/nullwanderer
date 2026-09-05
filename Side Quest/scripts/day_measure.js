#!/usr/bin/env node
/**
 * scripts/day_measure.js — read a window of the loop's life from the live database (READ-ONLY) and write
 * the ledger (lib/day_measure) to docs/measure/DAY_<date>_<from>.md.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/day_measure.js --from "2026-09-05 16:15" [--to "2026-09-06 16:15"]
 * Never writes to the database; never runs a model.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const arg = (k, d = null) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const parseWhen = (s, d) => { if (!s) return d; const t = Date.parse(s.replace(' ', 'T')); return Number.isFinite(t) ? t : d; };
const now = Date.now();
const from = parseWhen(arg('--from'), now - 24 * 3600000);
const to = Math.min(now, parseWhen(arg('--to'), now));
const Database = require('better-sqlite3');
const db = new Database(path.join(ROOT, 'data', 'sq.db'), { readonly: true, fileMustExist: true });
const events = db.prepare('SELECT ts, lane, kind, text, data FROM obs_events WHERE ts >= ? AND ts < ?').all(from, to);
const turns = db.prepare('SELECT ts, speaker, model, unprompted, substr(content, 1, 200) AS content FROM turns WHERE ts >= ? AND ts < ?').all(from, to);
const traces = db.prepare('SELECT ts, task, model, valid FROM cloud_traces WHERE ts >= ? AND ts < ?').all(from, to);
let spend = [];
try { const ring = JSON.parse(db.prepare("SELECT value FROM meta WHERE key='usage.meter.ring'").get().value); spend = Array.isArray(ring) ? ring : (ring.items || ring.ring || []); } catch {}
const meta = (k) => { try { const r = db.prepare('SELECT value FROM meta WHERE key=?').get(k); return r ? r.value : null; } catch { return null; } };
const quota = { limit: Number(meta('quota.limit_compute')) || null, startPct: null, endPct: null };
try {
  const q = require(path.join(ROOT, 'lib', 'quota'));
  const st = q.state({ limit: quota.limit || 0, markPct: Number(meta('quota.mark_pct')) || 0, markAt: Number(meta('quota.mark_at')) || 0, spentSince: 0, resetAt: Number(meta('quota.reset_at')) || 0, now });
  quota.endPct = st.known ? st.usedPct : null;
} catch {}
const { ledger } = require(path.join(ROOT, 'lib', 'day_measure'));
const { md, summary } = ledger({ from, to, events, turns, traces, spend, quota, weightFor: (() => { try { return require(path.join(ROOT, 'lib', 'quota')).weightFor; } catch { return null; } })(), now });
const outDir = path.join(ROOT, 'docs', 'measure');
fs.mkdirSync(outDir, { recursive: true });
const d = new Date(from); const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
const outPath = path.join(outDir, `DAY_${stamp}.md`);
fs.writeFileSync(outPath, md + '\n\n<!-- summary ' + JSON.stringify(summary) + ' -->\n', 'utf8');
console.log(md);
console.log(`\n[day_measure] written → ${path.relative(ROOT, outPath)} (events ${events.length}, turns ${turns.length}, traces ${traces.length}, spend rows ${spend.length})`);
db.close();
