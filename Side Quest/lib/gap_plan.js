/*
 * lib/gap_plan.js — BUILD 3 (2026-08-21): the GAP-PLAN APPROVAL SURFACE.
 *
 * Lucas, 08-21, the hollow-report post-mortem: "why are there gaps at all? why have we not filled
 * the gaps or presented a plan for approval to do something more agressive that might need
 * approval" — the program held 140+ open questions cycling silently on TTL backoff and never once
 * brought him the plan. This organ is the cure: a periodic sweep over the open-gap inventory that
 * classifies every item into three buckets and presents ONE consolidated plan in chat:
 *
 *   FILLABLE   — my current tools can get this; queued, the metabolism drains it. A status line,
 *                never an ask.
 *   BLOCKED    — only Lucas can unblock it (a key never registered, a registered key the service
 *                rejects, an account). Each row carries the EXACT working command — the bare
 *                `nx-echo` recipe burned him once (not on PATH), so the full venv path is printed.
 *   AGGRESSIVE — fillable, but only by a move worth an explicit go (a whole-site crawl, a long
 *                directed deep-browse session). The plan ASKS; it never just does. Approval is a
 *                plain-words order ("run the deep crawl on X") that the EXISTING directed-research
 *                and swarm lanes already execute — no new approval token, so there is no say-do gap
 *                between what the plan invites and what the program can run.
 *
 * Cadence: at most one plan per _MIN_INTERVAL_MS (20h); re-presented only when the PICTURE changed
 * (fingerprint over blocked + aggressive membership) or _REAIR_MS (7d) passed — a surface, never a
 * nag. Nothing to ask (both action buckets empty) → silent (the metabolism trend line already logs
 * the fillable backlog). Delivery is DETERMINISTIC text through the unprompted chat door — a cloud
 * paraphrase could garble key names and commands, and the asks must be exact.
 *
 * Pure decision logic + a fail-soft edge (maybePresent). All I/O injected: `dispatch` reaches Echo
 * (list_api_keys / secrets_check, both read-only), `deliver` lands the chat turn (main.js owns the
 * window). Every failure degrades to "no plan this tick" — never a throw into the metabolism.
 */
'use strict';

const str = (v) => (v == null ? '' : String(v));
let _db = null;
function db() { if (!_db) _db = require('./db'); return _db; }

const _MIN_INTERVAL_MS = 20 * 3600 * 1000;   // at most one plan per ~day
const _REAIR_MS = 7 * 24 * 3600 * 1000;      // an unchanged plan re-airs weekly, not daily
const _AGGRESSIVE_ATTEMPTS = 3;              // the passive verify cycle has failed this many times
const _AGGRESSIVE_AGE_MS = 10 * 24 * 3600 * 1000;   // a report-born gap (priority>=8) this old escalates
const _MAX_ROWS = 400;                        // sweep bound
const _SHOW = 5;                              // rows shown per action bucket — and the ASK CAP (09-04):
                                              // the plan names at most this many gos; the rest is a count.
// THE PASSIVE-CYCLE DIAGNOSIS (2026-09-04, the 19:26 catch: "322 need a go" out of 400 open). When
// at least this share of the open inventory has failed _AGGRESSIVE_ATTEMPTS passive passes, the
// broken thing is the passive cycle, not 322 gaps each deserving a crawl — the plan must say so
// instead of asking for 322 approvals (a plan that asks for everything asks for nothing). Half is
// the line: below it, stalled items are the exception the go-list exists for; at or above it, the
// go-list would be the whole queue.
const _STALL_SHARE = 0.5;
const _STALL_MIN_OPEN = 10;                   // below this many open items a share is noise, not a diagnosis
const _KEYS_CLI = '& "C:\\Users\\azrae\\Desktop\\NX ECHO\\nx-echo\\.venv\\Scripts\\nx-echo.exe" keys set';

// The capability keys the plan watches by name. Beyond these, any registry row with
// required:true left unset, and any dormant row, also blocks.
// SEARCH KEYS DECLINED (Lucas 08-21: "Lets skip those for now and just use the stealth
// browsering even if we need to open more stealth browser lanes") — EXA/JINA/TAVILY/BRAVE are
// deliberately OFF the watch AND on a suppress list: the browser lanes ARE the search path, and
// the plan must never nag a key he has decided not to set. _DECLINED also mutes their dormant/
// probe-rejected rows (the mis-pasted Exa key would otherwise nag forever).
const _WATCH = new Set(['CONGRESS_GOV_API_KEY']);
const _DECLINED = new Set(['EXA_API_KEY', 'JINA_API_KEY', 'TAVILY_API_KEY', 'BRAVE_SEARCH_API_KEY', 'SEARXNG_INSTANCE_URL']);
const _KEY_ROLE = {
  CONGRESS_GOV_API_KEY: 'federal bills + members (the transcript lane is dark without it)',
};

// What the aggressive move IS, by gap kind — named concretely so the go Lucas gives is an order
// the existing lanes execute verbatim.
const _AGGRESSIVE_ACTION = {
  'local-roster': 'a full crawl of the official parish/county site',
  'absence': 'a whole-site crawl of the official source',
  'open-question': 'a directed deep-browse research session in my own browser',
  'discrepancy': 'a deep-browse pass over the official record plus its archived (wayback) history',
  'vacancy': 'a deep-browse pass over the official record plus its archived (wayback) history',
};
const _DEFAULT_ACTION = 'a directed deep-browse research session in my own browser';

// A queue item whose own text names a credential need is Lucas-blocked, not tool-fillable.
const _ITEM_BLOCKED_RE = /\b(api[ _-]?key|credential|password|login|paywall|subscri|account access)\b/i;

function djb2(s) { let h = 5381; const t = str(s); for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) >>> 0; return h.toString(36); }

/** classifyItem(item, now) → {bucket:'fillable'|'blocked'|'aggressive', action?, why?} — pure. */
function classifyItem(item, now = Date.now()) {
  const d = item.detail || {};
  const text = `${str(item.subject)} ${JSON.stringify(d)}`;
  if (_ITEM_BLOCKED_RE.test(text)) return { bucket: 'blocked', why: 'names a credential/access need' };
  const attempts = Number(item.attempts || 0);
  const age = now - Number(item.created_ts || now);
  if (attempts >= _AGGRESSIVE_ATTEMPTS) {
    return { bucket: 'aggressive', action: _AGGRESSIVE_ACTION[item.kind] || _DEFAULT_ACTION, why: `${attempts} passive attempts came back empty` };
  }
  if (Number(item.priority || 0) >= 8 && age >= _AGGRESSIVE_AGE_MS) {
    return { bucket: 'aggressive', action: _AGGRESSIVE_ACTION[item.kind] || _DEFAULT_ACTION, why: `report-born and ${Math.round(age / 86400000)}d old` };
  }
  return { bucket: 'fillable' };
}

/** keyBlockers(rows, probes) → [{name, role, state:'unset'|'rejected', detail}] — pure over the
 * list_api_keys registry rows + an optional {service_id → secrets_check result} probe map. Watch
 * keys and required keys sort first; capped downstream by compose. */
function keyBlockers(rows, probes = {}) {
  const out = [];
  for (const r of (rows || [])) {
    if (!r || !r.name) continue;
    if (_DECLINED.has(r.name)) continue;   // Lucas declined these — never a blocker, never a nag
    const role = _KEY_ROLE[r.name] || str(r.display_name || r.scope_note).slice(0, 70) || 'a keyed capability';
    if (r.dormant) { out.push({ name: r.name, role, state: 'rejected', detail: str(r.dormant_reason).slice(0, 90) || 'registered but the service rejects it' }); continue; }
    const probe = r.service_id ? probes[r.service_id] : null;
    if (r.is_set && probe && probe.ok === false && probe.key_set !== false) {
      out.push({ name: r.name, role, state: 'rejected', detail: probe.status_code ? `the service rejects it (HTTP ${probe.status_code}) — likely a mis-paste` : 'the service rejects it' });
      continue;
    }
    if (!r.is_set && (_WATCH.has(r.name) || r.required === true)) out.push({ name: r.name, role, state: 'unset', detail: 'never registered' });
  }
  const rank = (b) => (_WATCH.has(b.name) ? 0 : b.state === 'rejected' ? 1 : 2);
  out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return out;
}

/** buildPlan({items, absenceOpen, keyRows, probes, now}) → the plan object — pure.
 * THE SUBJECT FLOOR (08-21, the "nonsensical unprompt" catch): absence items whose subject the
 * metabolism cannot research ("that", "scratch doc", a URL) are dropped BEFORE classification —
 * they were being presented to Lucas as gaps needing "a whole-site crawl of the official source". */
function buildPlan({ items = [], absenceOpen = 0, keyRows = [], probes = {}, now = Date.now() } = {}) {
  const researchable = require('./recheck_queue').researchable;
  // LAX floor: absence-ttl rows arrive lowercased from the absence store, and a real lowercase
  // subject must still reach the plan. Strict proper-noun filtering happens at the PRODUCER.
  items = items.filter((it) => it.kind !== 'absence' || researchable(it.subject, { requireProper: false }));
  const fillable = [], blockedItems = [], aggressive = [];
  for (const it of items) {
    const c = classifyItem(it, now);
    if (c.bucket === 'aggressive') aggressive.push({ ...it, action: c.action, why: c.why });
    else if (c.bucket === 'blocked') blockedItems.push({ ...it, why: c.why });
    else fillable.push(it);
  }
  // The ask cap + the diagnosis: at most _SHOW named gos; the remainder is `stalled`, and when the
  // stalled share says the passive cycle itself is broken, the plan reports a defect, not 300 asks.
  const stalled = Math.max(0, aggressive.length - _SHOW);
  const passiveBroken = items.length >= _STALL_MIN_OPEN && (aggressive.length / items.length) >= _STALL_SHARE;
  return {
    fillable, blockedItems, aggressive,
    blockedKeys: keyBlockers(keyRows, probes),
    absenceOpen: Number(absenceOpen) || 0,
    counts: { open: items.length, fillable: fillable.length, blocked: blockedItems.length, aggressive: aggressive.length, asked: Math.min(aggressive.length, _SHOW), stalled },
    passiveBroken,
    now,
  };
}

/** fingerprint(plan) → stable hash over WHAT NEEDS ACTION (blocked + aggressive membership).
 * The fillable count deliberately stays out — its daily churn must not re-air an unchanged ask. */
function fingerprint(plan) {
  const parts = []
    .concat(plan.blockedKeys.map((b) => `k:${b.name}:${b.state}`).sort())
    .concat(plan.blockedItems.map((b) => `bi:${b.id || b.subject}`).sort())
    .concat(plan.aggressive.map((a) => `ag:${a.id || a.subject}`).sort());
  return djb2(parts.join('|'));
}

/** chatLine(plan) → the ONE-TO-TWO-SENTENCE chat surface, her voice, NO CLI, NO lists.
 * Lucas 08-21 ("this is the second nonsensical long unprompt"): a 2.4KB wall of PowerShell
 * commands in her chat voice is the wrong register — the full sheet lives in the workspace doc
 * (compose below); chat only says the doc moved and what the headline is. */
function chatLine(plan) {
  const watchBlocked = plan.blockedKeys.filter((b) => _WATCH.has(b.name)).length + plan.blockedItems.length;
  const nGo = plan.aggressive.length;
  const nAsk = Math.min(nGo, _SHOW);   // THE ASK CAP (09-04): the chat line asks for at most _SHOW gos
  const stalled = (plan.counts && plan.counts.stalled) || 0;
  const top = nGo ? `"${str(plan.aggressive[0].subject).replace(/\s+/g, ' ').trim().slice(0, 60)}"` : '';
  const bits = [];
  if (nGo) bits.push(`${nAsk} gap(s) are worth a deeper dig — top of the list: ${top}`);
  if (watchBlocked) bits.push(`${watchBlocked} thing(s) need your hand`);
  // The remainder is a COUNT, and when the count says the passive cycle is what's broken, the line
  // names that as my defect — never as N crawls for him to approve.
  const tail = !stalled ? ''
    : plan.passiveBroken
      ? ` ${stalled} more are stalled on my passive cycle (${_AGGRESSIVE_ATTEMPTS}+ empty passes each) — that's mine to fix, not ${stalled} crawls to approve.`
      : ` ${stalled} more wait on the same kind of go — they're in the sheet.`;
  return `I've updated my gap plan — the full sheet is in my notes (gap_plan.md). Short version: ${bits.join(', and ')}.${tail} Ask me to walk through it, or give a go in plain words and I'll run it.`;
}

/** compose(plan, {userName, projects}) → the FULL plan sheet (the workspace DOC body, not chat) —
 *  pure. `projects` = deliverable_projects.list({openScopeOnly:true}) rows (P1 slice 2): ongoing
 *  deliverables with scope still to fold in ride the sheet so "what's outstanding" has ONE page. */
function compose(plan, { userName = 'Lucas', projects = [] } = {}) {
  const L = [];
  const sub = (s, n = 80) => str(s).replace(/\s+/g, ' ').trim().slice(0, n);
  L.push(`Here's my standing gap plan — what I know I don't know, and what each gap needs. (${plan.counts.open} open items on the queue${plan.absenceOpen ? `; ${plan.absenceOpen} absence gap(s) cycling on their own timers` : ''}.)`);
  if (projects.length) {
    L.push(`\nOngoing deliverable projects with OPEN scope — mine to finish, listed so you can steer:`);
    projects.slice(0, 6).forEach((p, i) => {
      const open = (p.scope || []).filter((s) => s.status === 'open');
      L.push(`${i + 1}. ${sub(p.title || p.slug, 70)} — ${open.length} open item(s): ${open.slice(0, 3).map((s) => `"${sub(s.item, 50)}"`).join('; ')}${open.length > 3 ? ` (+${open.length - 3} more)` : ''}`);
    });
    if (projects.length > 6) L.push(`(+${projects.length - 6} more projects with open scope.)`);
  }
  if (plan.counts.fillable) {
    const next = plan.fillable.slice(0, 3).map((f) => `"${sub(f.subject, 60)}"`).join(', ');
    L.push(`\nWorking on my own — no action needed: ${plan.counts.fillable} item(s) my current tools can fill; the metabolism drains them around the clock.${next ? ` Next up: ${next}.` : ''}`);
  }
  const blocked = plan.blockedKeys.slice(0, 6);
  if (blocked.length || plan.blockedItems.length) {
    L.push(`\nBlocked — these need your hand:`);
    blocked.forEach((b, i) => {
      const fix = b.state === 'rejected'
        ? `${b.detail}. Re-set it: ${_KEYS_CLI} ${b.name}`
        : `never registered. Register it: ${_KEYS_CLI} ${b.name}`;
      L.push(`${i + 1}. ${b.name} — ${b.role}: ${fix}`);
    });
    plan.blockedItems.slice(0, Math.max(0, _SHOW - blocked.length)).forEach((b, i) => {
      L.push(`${blocked.length + i + 1}. "${sub(b.subject)}" — ${b.why}.`);
    });
    const hidden = (plan.blockedKeys.length - blocked.length) + Math.max(0, plan.blockedItems.length - Math.max(0, _SHOW - blocked.length));
    if (hidden > 0) L.push(`(+${hidden} more blocked — ask for the full list.)`);
  }
  if (plan.aggressive.length) {
    L.push(`\nNeeds your go — I can fill these, but the move is aggressive enough that I want a yes first:`);
    plan.aggressive.slice(0, _SHOW).forEach((a, i) => {
      L.push(`${i + 1}. "${sub(a.subject)}" (${a.why}) → ${a.action}.`);
    });
    if (plan.aggressive.length > _SHOW) {
      L.push(plan.passiveBroken
        ? `(+${plan.aggressive.length - _SHOW} more have each failed ${_AGGRESSIVE_ATTEMPTS}+ passive passes — the passive cycle isn't clearing them. That's a defect on my side to fix, not ${plan.aggressive.length - _SHOW} crawls for you to approve; they stay on the cycle.)`
        : `(+${plan.aggressive.length - _SHOW} more waiting on the same kind of go.)`);
    }
    L.push(`Tell me in plain words which to run — e.g. "run the deep crawl on ${sub(plan.aggressive[0].subject, 50)}" — and I'll take it from there. Anything without a go stays on the passive cycle.`);
  }
  return L.join('\n').slice(0, 2400);
}

// ── the edge — cadence-gated sweep + present ────────────────────────────────────────────────────
// dispatch(tag, opts) reaches Echo fail-soft (null when down); deliver(text) lands the ONE-LINE
// chat turn; writeDoc(text) lands the full sheet in the workspace (best-effort — a doc-write
// failure never blocks the chat line, and vice versa).
/** doorOpen({idleTier, away, gate}) → {open, why} — the unprompted DOOR for the plan (2026-09-04, the
 * 19:26 catch: the plan fired 14 minutes into an evening with Lucas present, because its only "lull"
 * test was the 30-second _conversationActive window — no idle tier, no away check, no unprompted
 * gate). Same doors as every other unprompted path: he is not away; the idle ladder has reached at
 * least the hygiene tier (≥15 min since his last turn by default, meta-overridable like the ladder
 * itself); and the structural unprompted gate allows (no pending user turn, no streak). Pure —
 * the three readings are gathered by the caller. */
function doorOpen({ idleTier = 0, away = false, gate = null } = {}) {
  if (away) return { open: false, why: 'Lucas away' };
  if (!(Number(idleTier) >= 1)) return { open: false, why: 'idle tier 0 — he just spoke' };
  if (gate && gate.allow === false) return { open: false, why: `unprompted gate: ${gate.reason || 'blocked'}` };
  return { open: true, why: 'ok' };
}

async function maybePresent({ now = Date.now(), dispatch = null, deliver = null, writeDoc = null, door = null } = {}) {
  try {
    if (typeof deliver !== 'function') return { presented: false, reason: 'no-deliver' };
    const last = parseInt(db().getMeta('gapplan.last_ts') || '0', 10);
    if (now - last < _MIN_INTERVAL_MS) return { presented: false, reason: 'cadence' };
    // The door is judged AFTER the cadence so a closed door is only reported when a plan is actually due.
    if (door && door.open === false) return { presented: false, reason: `door-closed (${door.why || 'closed'})` };

    // 1) the open-gap inventory (promises are delivery debts, not gaps — excluded like the drain).
    const items = db().getDb().prepare(
      `SELECT id, kind, subject, detail, priority, attempts, created_ts FROM recheck_queue
       WHERE status = 'open' AND kind != 'promise' ORDER BY priority DESC, created_ts ASC LIMIT ?`
    ).all(_MAX_ROWS).map((r) => ({ ...r, detail: r.detail ? (() => { try { return JSON.parse(r.detail); } catch { return null; } })() : null }));
    let absenceOpen = 0; try { absenceOpen = require('./absence').openGaps({ limit: 100000 }).length; } catch {}

    // 2) the key registry + probes for set-but-suspect watch keys (both read-only; fail-soft).
    let keyRows = [], probes = {};
    if (typeof dispatch === 'function') {
      try {
        const kr = await dispatch({ kind: 'do', name: 'list_api_keys', args: {} }, { autonomous: true });
        if (kr && kr.text && !kr.isError) { const j = JSON.parse(kr.text); keyRows = Array.isArray(j) ? j : (j.result || []); }
      } catch { /* Echo down → key section simply absent this cycle */ }
      const toProbe = keyRows.filter((r) => r && r.is_set && !r.dormant && r.can_probe && _WATCH.has(r.name) && r.service_id).slice(0, 4);
      for (const r of toProbe) {
        try {
          const pr = await dispatch({ kind: 'do', name: 'secrets_check', args: { service_id: r.service_id } }, { autonomous: true });
          if (pr && pr.text && !pr.isError) { const j = JSON.parse(pr.text); probes[r.service_id] = j.result || j; }
        } catch { /* a failed probe is no verdict */ }
      }
    }

    // 3) build; nothing needing HIM → silent (the trend line already logs the fillable backlog).
    const plan = buildPlan({ items, absenceOpen, keyRows, probes, now });
    if (!plan.blockedKeys.length && !plan.blockedItems.length && !plan.aggressive.length) {
      return { presented: false, reason: 'nothing-needs-action' };
    }

    // 4) fingerprint gate — an unchanged picture re-airs weekly, never daily.
    const fp = fingerprint(plan);
    if (fp === db().getMeta('gapplan.fp') && now - last < _REAIR_MS) return { presented: false, reason: 'unchanged' };

    let _projects = []; try { _projects = require('./deliverable_projects').list({ openScopeOnly: true }); } catch { /* spine absent → section absent */ }
    try { if (typeof writeDoc === 'function') writeDoc(compose(plan, { projects: _projects })); } catch { /* the sheet is best-effort */ }
    deliver(chatLine(plan));
    db().setMeta('gapplan.last_ts', String(now));
    db().setMeta('gapplan.fp', fp);
    return { presented: true, reason: `${plan.counts.blocked + plan.blockedKeys.length} blocked, ${plan.counts.aggressive} need a go, ${plan.counts.fillable} fillable` };
  } catch (e) { return { presented: false, reason: `error: ${e.message}` }; }
}

module.exports = { classifyItem, keyBlockers, buildPlan, fingerprint, compose, chatLine, maybePresent, doorOpen, _WATCH, _DECLINED, _AGGRESSIVE_ATTEMPTS, _MIN_INTERVAL_MS, _REAIR_MS, _SHOW, _STALL_SHARE, _STALL_MIN_OPEN };
