/**
 * Offline smoke for lib/forecast_reactor.js — news signals → race perturbations (the reactive layer).
 * Deterministic (now + assess injected). Verifies the volatility-vs-attribution split, caps, decay,
 * routing, live detection, fail-safe, and the chain into forecast_sim.
 * Run: node scripts/smoke_forecast_reactor.js
 */
const R = require('../lib/forecast_reactor');
const SIM = require('../lib/forecast_sim');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } }
function near(name, got, want, tol = 0.05) { ok(name, Math.abs(got - want) <= tol, `got ${got} want ${want}±${tol}`); }

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-07-03T12:00:00Z');
const raceV = { id: 'S-OH', chamber: 'senate', margin: -2, sigma: 5, entities: ['JD Vance', 'Ohio'] };
const raceB = { id: 'S-WI', chamber: 'senate', margin: 1, sigma: 5, entities: ['Baldwin', 'Wisconsin'] };
const ev1 = { id: 1, title: 'Major endorsement in Ohio Senate race for Vance', entities: ['JD Vance', 'Ohio'], corroboration: 6, last_ts: NOW - HOUR };
const spike = { entity: 'JD Vance', mentions: 40, video_mentions: 25 };
const quiet = { entity: 'Baldwin', mentions: 3, video_mentions: 1 };
const signals = { events: [ev1], momentum: [spike, quiet] };

// --- NO assess: volatility only, never a phantom directional swing ---
const noAtt = R.reactRace(raceV, signals, { now: NOW });
ok('no-assess: live flag set by CC spike', noAtt.live === true);
ok('no-assess: news_delta = 0 (no direction without attribution)', noAtt.news_delta === 0, String(noAtt.news_delta));
near('no-assess: sigma bumped by spike + event-volatility', noAtt.sigma, 5 + 1.5 + 0.6 * Math.pow(0.5, 1 / 12), 0.05);
ok('no-assess: flagged provisional', noAtt.provisional === true);
ok('no-assess: audit has live-spike + event-volatility', noAtt.audit.some((a) => a.kind === 'live-spike') && noAtt.audit.some((a) => a.kind === 'event-volatility'));

// --- WITH assess: corroborated + attributed → signed margin shift ---
const assessA = () => ({ favors: 'A', magnitude: 'medium', confidence: 1 });
const att = R.reactRace(raceV, signals, { now: NOW, assess: assessA });
near('attributed: margin shifts toward A (medium, 1h decay)', att.news_delta, 1.2 * Math.pow(0.5, 1 / 12), 0.05);
near('attributed: new margin = base + delta', att.margin, -2 + 1.2 * Math.pow(0.5, 1 / 12), 0.05);
near('attributed: sigma bump = spike only (event was attributed, not volatility)', att.sigma, 6.5, 0.02);
ok('attributed: audit records the shift + direction', att.audit.some((a) => a.kind === 'attributed-shift' && a.favors === 'A'));
const attB = R.reactRace(raceV, signals, { now: NOW, assess: () => ({ favors: 'B', magnitude: 'large', confidence: 1 }) });
ok('attributed B: margin shifts the other way (negative)', attB.news_delta < 0);

// --- routing: unrelated race is untouched ---
const other = R.reactRace(raceB, signals, { now: NOW, assess: assessA });
ok('routing: unrelated race has empty audit', other.audit.length === 0);
ok('routing: unrelated race margin unchanged', other.margin === 1 && other.news_delta === 0);

// --- caps ---
const manyBig = { events: [1, 2, 3, 4, 5].map((i) => ({ id: i, title: 'Vance Ohio event ' + i, entities: ['JD Vance'], corroboration: 5, last_ts: NOW })), momentum: [] };
const capped = R.reactRace(raceV, manyBig, { now: NOW, assess: () => ({ favors: 'A', magnitude: 'large', confidence: 1 }) });
ok('cap: total margin delta clamped to eventMarginCap (3)', Math.abs(capped.news_delta) <= 3 + 1e-9 && capped.news_delta === 3, String(capped.news_delta));
const manySpikes = { events: [], momentum: [1, 2, 3, 4, 5].map((i) => ({ entity: 'JD Vance', mentions: 50, video_mentions: 30 })) };
ok('cap: sigma bump clamped to sigmaBumpCap (4)', R.reactRace(raceV, manySpikes, { now: NOW }).sigma_bump <= 4 + 1e-9);

// --- decay: an old event contributes less than a fresh one ---
const fresh = R.reactRace(raceV, { events: [{ id: 9, title: 'Vance Ohio', entities: ['JD Vance'], corroboration: 4, last_ts: NOW }], momentum: [] }, { now: NOW, assess: assessA }).news_delta;
const old = R.reactRace(raceV, { events: [{ id: 9, title: 'Vance Ohio', entities: ['JD Vance'], corroboration: 4, last_ts: NOW - 48 * HOUR }], momentum: [] }, { now: NOW, assess: assessA }).news_delta;
ok('decay: fresh event moves margin more than a 48h-old one', fresh > old && old > 0, `fresh ${fresh} old ${old}`);

// --- fail-safe: a throwing assess → volatility only, no crash, no phantom shift ---
const boom = R.reactRace(raceV, signals, { now: NOW, assess: () => { throw new Error('cloud down'); } });
ok('fail-safe: assess throws → news_delta 0 (volatility only), no crash', boom.news_delta === 0 && boom.sigma > 5);

// --- detectLive + react() slate + chain into the simulator ---
ok('detectLive: flags the spiking entity only', JSON.stringify(R.detectLive([spike, quiet]).map((x) => x.entity)) === JSON.stringify(['JD Vance']));
const slate = R.react([raceV, raceB], signals, { now: NOW, assess: assessA });
ok('react(): moved list contains only the touched race', slate.moved.map((r) => r.id).join(',') === 'S-OH');
const sim = SIM.simulate(slate.races, { iterations: 500, seed: 1, holdovers: { senate: { A: 48, B: 49 } }, majority: { senate: 51 } });
ok('chain: reactor output feeds forecast_sim (produces control prob)', sim.chambers.senate && typeof sim.chambers.senate.pA_control === 'number');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
