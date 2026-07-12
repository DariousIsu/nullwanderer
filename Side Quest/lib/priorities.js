'use strict';
// lib/priorities.js — OPTIONAL, DATED research-focus override for the idle walk.
//
// The idle walk's DEFAULT anchor is dynamic (monologue.activeSetNames follows the operator's recent
// engagement: his dropped docs + conversation). This module is the light, EXPIRING override for when Lucas
// wants to point her at something specific for a while ("this week, dig into X"). It is NOT a hardcoded
// priority list — that was brittle (went stale, couldn't pivot to a new region next week). Empty by default;
// when set it LEADS activeSetNames until it expires, then the walk goes back to pure recent-engagement.
//
// set(db, ['Colorado River water','US-Israel water security'], {days:7}) → pins for a week.
// clear(db) → back to default. getActive(db) → current non-expired items (or []).

const META_KEY = 'research_focus';

function getActive(db) {
  try {
    const raw = (db && db.getMeta) ? db.getMeta(META_KEY) : null;
    if (!raw) return [];
    const o = JSON.parse(raw);
    if (o && Array.isArray(o.items) && (!o.expires || o.expires > Date.now())) {
      return o.items.map(x => String(x || '').trim()).filter(x => x.length >= 2);
    }
  } catch { /* fall through */ }
  return [];
}

function set(db, items, { days = 7 } = {}) {
  const list = (Array.isArray(items) ? items : [items]).map(x => String(x || '').trim()).filter(Boolean);
  const expires = (days && days > 0) ? Date.now() + days * 86400 * 1000 : null;
  try { db.setMeta(META_KEY, JSON.stringify({ items: list, expires, set_at: Date.now() })); return getActive(db); } catch { return []; }
}

function clear(db) { try { db.setMeta(META_KEY, ''); } catch { /* noop */ } return []; }

function status(db) {
  try {
    const raw = (db && db.getMeta) ? db.getMeta(META_KEY) : null;
    if (!raw) return { active: false, items: [] };
    const o = JSON.parse(raw);
    const live = o && (!o.expires || o.expires > Date.now());
    return { active: !!(live && o.items && o.items.length), items: (o && o.items) || [], expires: o && o.expires || null };
  } catch { return { active: false, items: [] }; }
}

module.exports = { getActive, set, clear, status, META_KEY };
