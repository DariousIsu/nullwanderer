/**
 * lib/forecast_reactor.js — the REACTIVE layer: news signals → race-factor PERTURBATIONS ("winners update
 * as news flows in"). Consumes the news_feed contract (events/momentum) and emits updated race inputs for
 * forecast_sim. This is the piece that makes the machine live.
 *
 * TWO effects, deliberately separated (Lucas's priority = live breaking moments — speeches, press
 * conferences, election night — where corroboration LAGS the moment):
 *   1. VOLATILITY (σ↑) — direction-FREE, IMMEDIATE. A momentum spike (broadcast-CC surge) or an
 *      un-attributed event means "something is moving, direction unknown yet" → widen the race. This is
 *      the fast live-mode reaction; needs no interpretation, so it fires the instant the CCs spike.
 *   2. MARGIN SHIFT (signed) — needs ATTRIBUTION. Only a CORROBORATED event whose direction is judged
 *      (by the injected `assess` = gpt-oss) shifts the margin, bounded + decaying. Absent `assess`, news
 *      only adds volatility, never a phantom directional swing.
 *
 * HONESTY GUARD-RAILS (this is R&D — do not fake precision): the magnitudes below are TUNABLE PRIORS, not
 * validated coefficients — the calibration harness scores whether they help. Every adjustment is flagged
 * `provisional` (news is a between-polls signal; the next poll overrides it) and fully AUDITED (what moved
 * which race and why → the parts→whole transparency). Deltas are recency-DECAYED and hard-CAPPED so no
 * single burst can run away. PURE + deterministic (inject `now`, `assess`); fail-safe (a thrown assess is
 * ignored → volatility-only). Feeds forecast_sim: react() emits races in the {id,chamber,margin,sigma} shape.
 */
'use strict';

const { mentions } = require('./news_feed');   // top-level safe: news_feed's live readers are lazy-required inside fns

const DEFAULTS = {
  spikeVideoMentions: 8,     // broadcast-CC mentions in the window that flag a race "live/breaking"
  spikeMentions: 20,         // total mentions that flag activity
  sigmaBumpPerSpike: 1.5,    // σ (points) added when a race is live/spiking — direction-free volatility
  sigmaBumpPerEvent: 0.6,    // σ added by an un-attributed corroborated event
  sigmaBumpCap: 4,           // max total σ bump from news
  eventMarginCap: 3,         // max |signed margin shift| from news (points) — news can't swing a race alone
  attributedScale: { small: 0.5, medium: 1.2, large: 2.5 },  // assess magnitude → points (pre-cap)
  halfLifeHours: 12,         // news perturbation decay
  minCorroborationForShift: 2,
};

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const HOUR = 3600 * 1000;
function decay(tsMs, now, halfLifeHours) { if (!tsMs) return 1; const ageH = Math.max(0, (now - tsMs) / HOUR); return Math.pow(0.5, ageH / halfLifeHours); }

// Does a signal touch this race? race.entities = [candidate names, state, office…]; match bidirectionally.
function eventTouchesRace(ev, ents) {
  const txt = [ev.title, (ev.entities || []).join(' '), (ev.matched || []).join(' ')].filter(Boolean).join(' ');
  return ents.some((en) => mentions(txt, en));
}
function momentumTouchesRace(m, ents) {
  return ents.some((en) => mentions(m.entity, en) || mentions(en, m.entity));
}

/**
 * React one race to the news signals. Returns the race with margin/sigma updated + audit.
 * race: { id, chamber, margin, sigma, entities:[…] }
 * signals: { events:[…from news_feed.events/today], momentum:[…from news_feed.momentum] }
 * opts: { now=Date.now(), assess=null, cfg }
 *   assess(event, race) → { favors:'A'|'B'|'neutral', magnitude:'small'|'medium'|'large', confidence:0..1 }
 */
function reactRace(race, signals = {}, opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const c = { ...DEFAULTS, ...(opts.cfg || {}) };
  const assess = typeof opts.assess === 'function' ? opts.assess : null;
  const ents = race.entities || [];
  const evs = (signals.events || []).filter((e) => eventTouchesRace(e, ents));
  const mos = (signals.momentum || []).filter((m) => momentumTouchesRace(m, ents));

  const audit = [];
  let sigmaBump = 0, marginDelta = 0, live = false;

  // (1) VOLATILITY — momentum spikes (direction-free, immediate live-mode)
  for (const m of mos) {
    if ((m.video_mentions || 0) >= c.spikeVideoMentions || (m.mentions || 0) >= c.spikeMentions) {
      live = true; sigmaBump += c.sigmaBumpPerSpike;
      audit.push({ kind: 'live-spike', entity: m.entity, video_mentions: m.video_mentions || 0, mentions: m.mentions || 0, sigma_bump: c.sigmaBumpPerSpike });
    }
  }

  // (2) EVENTS — attributed corroborated events shift the margin (needs assess); else add volatility
  for (const e of evs) {
    const corr = e.corroboration || 0;
    const d = decay(e.last_ts, now, c.halfLifeHours);
    let attributed = false;
    if (assess && corr >= c.minCorroborationForShift) {
      let a = null; try { a = assess(e, race); } catch { a = null; }
      if (a && a.favors && a.favors !== 'neutral') {
        const sign = a.favors === 'A' ? 1 : -1;
        const mag = c.attributedScale[a.magnitude] || 0;
        const conf = a.confidence != null ? a.confidence : 1;
        const contrib = sign * mag * conf * d;
        marginDelta += contrib; attributed = true;
        audit.push({ kind: 'attributed-shift', event: e.id, title: (e.title || '').slice(0, 60), favors: a.favors, magnitude: a.magnitude, confidence: conf, delta: Number(contrib.toFixed(2)) });
      }
    }
    if (!attributed) {   // corroborated but undirected → volatility only (never a phantom swing)
      sigmaBump += c.sigmaBumpPerEvent * d;
      audit.push({ kind: 'event-volatility', event: e.id, title: (e.title || '').slice(0, 60), corroboration: corr, sigma_bump: Number((c.sigmaBumpPerEvent * d).toFixed(2)) });
    }
  }

  sigmaBump = clamp(sigmaBump, 0, c.sigmaBumpCap);
  marginDelta = clamp(marginDelta, -c.eventMarginCap, c.eventMarginCap);
  const provisional = sigmaBump > 0 || marginDelta !== 0;   // all news adjustment is provisional until a poll

  return {
    ...race,
    base_margin: race.margin,
    margin: Number((race.margin + marginDelta).toFixed(3)),
    sigma: Number(((race.sigma != null ? race.sigma : 5) + sigmaBump).toFixed(3)),
    news_delta: Number(marginDelta.toFixed(3)),
    sigma_bump: Number(sigmaBump.toFixed(3)),
    live, provisional, audit,
  };
}

// React a whole slate. Returns { races: updated[] (sim-ready), moved: [races that changed] }.
function react(races, signals = {}, opts = {}) {
  const updated = (Array.isArray(races) ? races : []).map((r) => reactRace(r, signals, opts));
  return { races: updated, moved: updated.filter((r) => r.audit && r.audit.length) };
}

// Which entities are currently "live" (breaking) — the momentum spike detector. → [{entity, video_mentions, mentions}]
function detectLive(momentum, opts = {}) {
  const c = { ...DEFAULTS, ...(opts.cfg || {}) };
  return (momentum || [])
    .filter((m) => (m.video_mentions || 0) >= c.spikeVideoMentions || (m.mentions || 0) >= c.spikeMentions)
    .map((m) => ({ entity: m.entity, video_mentions: m.video_mentions || 0, mentions: m.mentions || 0 }));
}

module.exports = { DEFAULTS, reactRace, react, detectLive, decay, eventTouchesRace, momentumTouchesRace };
