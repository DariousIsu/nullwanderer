/**
 * lib/backoff.js — the ONE failure-cooldown shape, made a shared organ (2026-07-30: six empty
 * cloud replies in one evening, each costing the full wait before the local fallback; the
 * graph-walk lane already had this pattern inline). Consecutive failures grow the cooldown
 * exponentially (1m → 2m → 4m … capped 30m); ONE success resets. Pure — callers persist the
 * {streak, until} state themselves (meta JSON) and decide what "failure" means.
 */
'use strict';

const BASE_MS = 60e3;
const CAP_MS = 30 * 60e3;

// Cooldown for the Nth consecutive failure (streak 1 → BASE, doubling, capped).
function next(streak) { return Math.min(CAP_MS, BASE_MS * Math.pow(2, Math.max(0, (streak | 0) - 1))); }

function shouldSkip(state, nowMs) { return !!(state && state.until && nowMs < state.until); }
function onFailure(state, nowMs) { const streak = (((state && state.streak) | 0) + 1); return { streak, until: nowMs + next(streak) }; }
function onSuccess() { return { streak: 0, until: 0 }; }

module.exports = { next, shouldSkip, onFailure, onSuccess, BASE_MS, CAP_MS };
