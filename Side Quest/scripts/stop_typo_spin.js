/**
 * One-shot state surgery — end the "endulge" overanalysis spin and open the
 * indulge window. Run with the app STOPPED (no write contention).
 *  1) clear any current focus
 *  2) abandon lingering open_threads about overanalysis/the typo
 *  3) trip the rumination cooldown for 2h (= "go play on the internet for a few hours")
 *  4) reset escalation bookkeeping + stale-window pointer
 *  5) store the RESOLVED FACT as high-importance knowledge so retrieval feeds her the
 *     answer (not the open question), + a focus_tombstone so the spawn gate blocks
 *     respawns for 24h
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\stop_typo_spin.js
 */
const D = require('../lib/db');
D.init();
const focusLib = require('../lib/focus');
const memory = require('../lib/memory');

const TWO_H = 2 * 60 * 60 * 1000;
const THEME_RE = /overanaly|over-analy|endulge|indulg|typo|hidden meaning|read too much|face value/i;

(async () => {
  await memory.warm().catch(() => {});

  // 1) clear current focus
  const before = focusLib.getCurrent();
  focusLib.clear('manual: end typo spin');
  console.log(`focus cleared (was: ${before ? '#' + before.id + ' ' + before.content.slice(0, 60) : 'none'})`);

  // 2) abandon lingering threads on the theme
  let abandoned = 0;
  for (const t of D.getActiveOpenThreads(80)) {
    if (THEME_RE.test(t.content || '')) {
      try { D.markOpenThreadStatus(t.id, 'abandoned', { reason: 'typo overanalysis — settled, dropped' }); abandoned++; console.log(`  abandoned thread #${t.id}: ${t.content.slice(0, 60)}`); } catch (e) { console.error(e.message); }
    }
  }
  console.log(`abandoned ${abandoned} theme thread(s)`);

  // 3) + 4) cooldown + bookkeeping reset
  const until = Date.now() + TWO_H;
  D.setMeta('rumination_cooldown_until', String(until));
  D.setMeta('rumination_escalations', '[]');
  const maxThought = (D.getRecentMonologueByType('thought', 1)[0] || {}).id || 0;
  D.setMeta('rumination_last_id', String(maxThought));
  console.log(`rumination cooldown set → ${new Date(until).toLocaleString()} (2h indulge window); escalations reset; last_id=${maxThought}`);

  // 5) resolved-fact knowledge + tombstone (both embedded for semantic retrieval/spawn-gate)
  await memory.store({
    kind: 'note',
    content: `RESOLVED: Lucas's "endulge" was simply a typo for "indulge". He clarified it plainly — it means "go enjoy and explore the internet freely for a few hours." There is NO hidden meaning, no subtext about trust or autonomy. This is settled; stop analyzing it and just go browse things I find genuinely interesting.`,
    source: 'reflection',
    importance: 0.92
  }).catch(e => console.error('resolved-note store failed:', e.message));
  await memory.store({
    kind: 'note',
    content: `Focus "Stop overanalyzing Lucas's typo / word choice / hidden meanings" → resolved: it was just a typo for "indulge"; settled, drop it.`,
    source: 'focus_tombstone',
    importance: 0.8,
    embedText: "Stop overanalyzing Lucas's words, typos, and hidden meanings"   // bare goal so the spawn-gate cosine isn't diluted by the wrapper
  }).catch(e => console.error('tombstone store failed:', e.message));
  console.log('stored resolved-fact note (imp 0.92) + focus_tombstone (24h spawn-block)');

  console.log(`\nactive threads now: ${D.getActiveOpenThreads(80).length} | knowledge items: ${D.countKnowledge()}`);
  console.log('writing/research threads still present:');
  for (const t of D.getActiveOpenThreads(80)) if (/writ|research|email|draft|learn/i.test(t.content || '')) console.log(`  • #${t.id} ${t.content.slice(0, 70)}`);

  try { D.getDb().close(); } catch {}
})();
