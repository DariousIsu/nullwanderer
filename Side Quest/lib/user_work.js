/**
 * lib/user_work.js — HIS WORK OUTRANKS THE SWEEP (Lucas 2026-07-30).
 *
 * Measured that morning: 8 user-origin research threads sat `pending` with action_count 0 —
 * the grid/data-center memo cluster, robot-control, Louisiana deep-research — while the
 * state-map fallback owned every idle window. The scheduler only protected a user focus that
 * already HELD the primary slot; nothing ever promoted an unstarted user thread INTO it. His
 * projects and the sweep weren't competing — only the sweep's queue had a driver.
 *
 * This module is the pure brain of the user-thread driver:
 *   - isResearchShaped:   which pending threads qualify as seedable research runs
 *   - parseDeadline:      "within an hour" vs "you have 6 hours" → dueTs + kind, anchored to
 *                         the thread's BIRTH (re-anchoring to now() would never expire)
 *   - matchNewsToThread:  working-topic news vigilance — related headlines matched to a live
 *                         story/paper so the work stays current
 *   - pickUserThread:     the ordering — deadline urgency > news heat > RECENCY (his newest
 *                         ask is usually the live one)
 *   - augmentGuidance:    the per-pass addenda (related news + deadline pacing)
 *
 * main.js owns the I/O: seeding/preemption in the autonomic tick (a seeded thread is a USER
 * focus — full cadence, browser-owning, never idle-tiered), news stamping in the maintenance
 * sweep, and the guidance splice in the directed pass.
 */
'use strict';

const RESEARCH_RE = /\b(research|substantiate|identify|compile|investigate|verify|map(?:ping)?|gather|analy[sz]e|understand|deep[- ]?dive|document|catalog(?:ue)?|trace|survey)\b/i;

// A seedable research thread: enough words to be a task, a research-shaped verb, and not a
// pure conversational commitment. Deliberately conservative — a miss stays a pending thread
// (visible, unharmed); a false seed steals the primary from real work.
function isResearchShaped(content) {
  const c = String(content || '').trim();
  if (c.split(/\s+/).length < 4) return false;
  return RESEARCH_RE.test(c);
}

// Deadline language → { dueTs, kind: 'rush' | 'today' | 'open' } or null (no deadline named).
// `anchorTs` is the thread's created_ts — "within an hour" means an hour from when he SAID it.
function parseDeadline(text, anchorTs) {
  const t = String(text || '').toLowerCase();
  const a = Number(anchorTs) || 0;
  if (!a) return null;
  let m;
  if (/\basap\b|\bright away\b|\bimmediately\b|\burgent(?:ly)?\b/.test(t)) return { dueTs: a + 30 * 60e3, kind: 'rush' };
  if ((m = t.match(/\bwithin (?:the next )?(\d+)\s*min(?:ute)?s?\b/))) return { dueTs: a + parseInt(m[1], 10) * 60e3, kind: 'rush' };
  if ((m = t.match(/\b(?:within|in|next|have(?: the next)?) (?:the next )?(an?|\d+)\s*(?:hour|hr)s?\b/))) {
    const n = /^a/.test(m[1]) ? 1 : parseInt(m[1], 10);
    return { dueTs: a + n * 3600e3, kind: n <= 2 ? 'rush' : 'today' };
  }
  if (/\bby (?:the )?end of (?:the )?day\b|\bby tonight\b|\bby eod\b/.test(t)) return { dueTs: a + 10 * 3600e3, kind: 'today' };
  if (/\bby (?:tomorrow|the morning)\b|\btomorrow morning\b/.test(t)) return { dueTs: a + 20 * 3600e3, kind: 'open' };
  if (/\bno rush\b|\bno hurry\b|\bwhenever\b/.test(t)) return { dueTs: null, kind: 'open' };
  return null;
}

// Working-topic news vigilance: match recent headlines to a thread's content by token overlap.
// ≥2 distinct content-token hits — one shared word ("grid") is coincidence, two is a topic.
// Work-shape and time-filler words are NOT topics (boot122 first-fire: "…over coming weeks"
// matched 3 unrelated stories on "coming"+"weeks" — ordinary news prose — and the false heat
// would have outranked his real grid cluster at the next pick).
const _STOP = new Set(['research', 'substantiate', 'identify', 'compile', 'investigate', 'verify', 'gather', 'understand', 'document', 'catalog', 'survey', 'trace', 'analyze', 'analyse', 'that', 'this', 'with', 'from', 'into', 'onto', 'about', 'their', 'each', 'every', 'lucas', 'help', 'find', 'right', 'needs', 'need', 'cases', 'where', 'would', 'could', 'should', 'been', 'have', 'more', 'most', 'what', 'when', 'were', 'will', 'coming', 'weeks', 'week', 'days', 'months', 'years', 'over', 'next', 'upcoming', 'topic', 'topics', 'provided', 'write', 'writing', 'written', 'report', 'reports', 'story', 'stories', 'paper', 'papers', 'draft', 'memo']);
function threadTokens(content) {
  return new Set(String(content || '').toLowerCase().match(/[a-z][a-z0-9-]{3,}/g)?.filter((w) => !_STOP.has(w)) || []);
}
function matchNewsToThread(content, headlines) {
  const toks = threadTokens(content);
  if (toks.size < 2) return [];
  const out = [];
  for (const h of (Array.isArray(headlines) ? headlines : [])) {
    const text = `${(h && h.title) || ''} ${(h && h.summary) || ''}`.toLowerCase();
    if (!text.trim()) continue;
    let hits = 0;
    for (const t of toks) { if (text.includes(t)) { hits++; if (hits >= 2) break; } }
    if (hits >= 2) out.push({ title: String(h.title || '').slice(0, 140), summary: String(h.summary || '').slice(0, 200) });
    if (out.length >= 5) break;
  }
  return out;
}

// The ordering. Deadline urgency dominates (overdue > rush > today), then news heat (a working
// topic in the news is hot for ~24h), then RECENCY — his newest ask wins ties.
function scoreThread(t, { now = 0, newsAt = 0 } = {}) {
  let s = 0;
  const dl = parseDeadline(t.content, t.created_ts);
  if (dl && dl.dueTs) {
    const left = dl.dueTs - now;
    s += left <= 0 ? 1000 : left < 2 * 3600e3 ? 800 : left < 8 * 3600e3 ? 400 : 150;
  }
  if (newsAt && now - newsAt < 24 * 3600e3) s += 200 * (1 - (now - newsAt) / (24 * 3600e3));
  const ageH = Math.max(0, now - (t.created_ts || 0)) / 3600e3;
  s += Math.max(0, 100 - Math.min(100, ageH));   // newest ask carries up to +100, fading over ~4 days
  return s;
}

// Pick the user thread the primary should run next: pending, never-driven, research-shaped,
// not beat-tagged (the caller filters beat tags — it has the meta). Null = nothing qualifies →
// the sweep may have the slot.
function pickUserThread(threads, { now = 0, newsAtOf = () => 0 } = {}) {
  let best = null, bestScore = -1;
  for (const t of (Array.isArray(threads) ? threads : [])) {
    if (!t || t.status !== 'pending' || (t.action_count | 0) !== 0) continue;
    if (!isResearchShaped(t.content)) continue;
    const s = scoreThread(t, { now, newsAt: newsAtOf(t.id) || 0 });
    if (s > bestScore || (s === bestScore && (t.created_ts || 0) > ((best && best.created_ts) || 0))) { best = t; bestScore = s; }
  }
  return best;
}

/**
 * The slice of a prior deliverable that is ABOUT this target — so a run can be handed what is
 * already established and build past it.
 *
 * Inheriting the parent document only got its conclusions into the WRITE-UP: `base_doc` was read
 * at synthesis time and nowhere else, so a spawned thread still re-researched its target from
 * scratch and only avoided restating it at the end. That is the wrong half of the saving. The
 * research passes are where the tokens go.
 *
 * Deliverables are written as `## <Target>` sections, so this is a deterministic slice of markdown
 * she already wrote — no model, nothing inferred. Matching is EXACT or CONTAINMENT (plus two shared
 * significant words), because a heading reads "AI for Science Institute (AISI)" while the target
 * may read "AI for Science Institute". Token overlap alone is NOT enough and the live proof is in
 * the scoring comment below. Null when nothing matches: handing a run the WRONG section as
 * established fact is far worse than handing it none.
 */
const _norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Does this plan facet belong to the target currently being researched?
 *
 * ⚠ A REGRESSION I CAUSED, caught live 2026-07-31. Making the run's own questions outrank the
 * generic ladder (a44be2f) is right when the questions are ABOUT the current target — which holds
 * for a spawned single-target thread. On a MULTI-TARGET discovery run it is wrong: the open-question
 * generator writes entity-specific facets ("What are the primary funding streams for AI2S…") while
 * researching AI2S, they stay in the run-level plan after the run moves on, and the deepen pass then
 * dutifully researched ICDI in order to answer a question about AI2S. Measured on #3639: 3 of its 9
 * plan facets named a specific org.
 *
 * Conservative by construction, and deliberately the opposite direction from the namesake fix: that
 * one refused to CLAIM identity on weak evidence; this one only EXCLUDES on strong evidence. A facet
 * is dropped only when it names a distinctive token belonging to another org this run has covered
 * AND does not name the current target. Generic facets ("Leadership & key staff") always apply, and
 * anything ambiguous stays — a wrongly-kept facet costs one pass, a wrongly-dropped one loses a real
 * question permanently.
 */
const _DISTINCTIVE = /\b[A-Z][A-Za-z]*\d?[A-Z]{1,}\d?\b/g;   // AI2S, ICDI, MGI, SAIS, CNRI, AI-RSL
// Words that org names are MADE of — they identify nobody. Without this list "Institute" or
// "Arizona" would look like a name and start excluding facets wholesale.
const _ORG_GENERIC = new Set([
  'institute', 'institutes', 'laboratory', 'laboratories', 'lab', 'labs', 'center', 'centre',
  'centers', 'university', 'college', 'school', 'department', 'division', 'office', 'academy',
  'alliance', 'coalition', 'council', 'committee', 'commission', 'board', 'foundation', 'society',
  'association', 'consortium', 'network', 'group', 'program', 'programme', 'project', 'initiative',
  'artificial', 'intelligence', 'science', 'sciences', 'scientific', 'research', 'technology',
  'technologies', 'computing', 'computation', 'computational', 'data', 'national', 'international',
  'state', 'federal', 'american', 'united', 'states', 'the', 'and', 'for', 'of', 'at', 'in', 'on',
  // ⚠ PLACES ARE NOT ORGANIZATIONS. Adding proper-noun extraction immediately over-excluded:
  // "Arizona" is the leading word of "Arizona Institute for AI and Society", so the perfectly
  // general facet "Geographic focus within Arizona" was dropped as belonging to another org. On a
  // run whose whole job is mapping one state, the state name appears everywhere and identifies
  // nobody. A closed, well-defined set — not a hack: these are the jurisdictions her work covers.
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware',
  'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky',
  'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi',
  'missouri', 'montana', 'nebraska', 'nevada', 'hampshire', 'jersey', 'mexico', 'york', 'carolina',
  'dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode', 'island', 'tennessee', 'texas',
  'utah', 'vermont', 'virginia', 'washington', 'wisconsin', 'wyoming', 'columbia', 'america',
  'china', 'chinese', 'shanghai', 'beijing', 'county', 'parish', 'city', 'town', 'district',
]);
/**
 * The tokens that actually IDENTIFY an organization: its acronym, and any distinctive proper noun.
 *
 * ⚠ Acronyms alone were not enough, and it missed live within the hour: the filter caught AI2S and
 * ICDI but sailed past "Eller AI Lab", because "Eller Artificial Intelligence Laboratory" has no
 * all-caps acronym and "AI" is below the length floor. So a facet asking what compute the ELLER lab
 * has was pursued against the Arizona AI Alliance. A name does not need an acronym to be a name.
 */
// The ACRONYM half on its own — a high-precision identifier. "CRES" or "AI2S" in a facet names that
// body and nothing else, which is what lets a facet mentioning two orgs still belong to the one it
// actually asks about.
function _acronyms(name) {
  const out = new Set();
  for (const m of String(name || '').match(_DISTINCTIVE) || []) {
    const t = m.replace(/[^A-Za-z0-9]/g, '');
    if (t.length >= 3 && t.length <= 8) out.add(t.toUpperCase());
  }
  return out;
}
function _marks(name) {
  const out = _acronyms(name);
  const s = String(name || '');
  // Distinctive proper nouns — "Eller", "Tsinghua", "Fulton". Capitalised, not org vocabulary,
  // and not a place/word so common it identifies nothing.
  for (const m of s.match(/\b[A-Z][a-z]{3,}\b/g) || []) {
    if (!_ORG_GENERIC.has(m.toLowerCase())) out.add(m.toUpperCase());
  }
  return out;
}
function facetAppliesTo(facet, targetName, otherNames = []) {
  const f = String(facet || '');
  if (!f.trim()) return false;
  const mine = _marks(targetName);
  const inFacet = _marks(f);
  if (!inFacet.size) return true;                       // no org marker at all → generic, applies

  // An acronym names one body and nothing else, so it settles ownership outright — including for a
  // facet that legitimately mentions two orgs ("how does AI2S collaborate with Mayo Clinic").
  for (const a of _acronyms(targetName)) if (inFacet.has(a)) return true;

  // THE PREFIX IS OWNERSHIP, STATED OUTRIGHT. The generator writes "<org> – <question>", so the
  // leading segment says who the facet was raised for. Scoring the whole string ignores that and
  // loses on questions that mention another body more often than their own subject: "U.S.
  // Department of Energy – What internal DOE drafts have cited The Green Grid's standards" is DOE's
  // question, but names The Green Grid twice and DOE once. Decide on the prefix when there is one.
  const lead = f.split(/\s+[–—-]\s+/)[0];
  if (lead && lead !== f && lead.length <= 90) {
    const leadMarks = _marks(lead);
    if (leadMarks.size) {
      let myLead = 0;
      for (const t of leadMarks) if (mine.has(t)) myLead++;
      let bestLead = 0;
      for (const n of (Array.isArray(otherNames) ? otherNames : [])) {
        if (String(n) === String(targetName)) continue;
        let s = 0;
        for (const t of _marks(n)) if (leadMarks.has(t)) s++;
        if (s > bestLead) bestLead = s;
      }
      if (myLead > 0 && myLead >= bestLead) return true;   // the prefix names ME → mine
      if (bestLead > myLead) return false;                 // the prefix names another body → theirs
    }
  }

  // COMPARATIVE, not membership. This used to return true on ANY shared mark, and a single ordinary
  // word was enough: _marks counts every capitalised non-stoplist word as identifying, so
  // "Conservative Energy Network" claimed a facet about the Bipartisan Policy Center's ENERGY
  // Advisory Council, and "State Policy Network" claimed one about Manhattan Institute for POLICY
  // Research. Measured 2026-07-31 on focus.3631: 13 of 168 cross-target facets survived.
  // Extending _ORG_GENERIC with "policy"/"energy"/"conservative" is the trap — in this domain every
  // org is BUILT from those words and the list can never catch up. So ask the discriminating
  // question instead: does the facet name someone else MORE specifically than it names me?
  // Ties and near-misses still keep the facet — a wrongly-kept facet costs one pass, a wrongly
  // dropped one loses a real question permanently.
  let myScore = 0;
  for (const t of inFacet) if (mine.has(t)) myScore++;
  for (const n of (Array.isArray(otherNames) ? otherNames : [])) {
    if (String(n) === String(targetName)) continue;
    let theirScore = 0;
    for (const t of _marks(n)) if (inFacet.has(t)) theirScore++;
    if (theirScore > myScore) return false;             // names ANOTHER covered org better → not ours
  }
  return true;                                          // an unrecognised marker is not evidence
}

/**
 * The organizations an inherited deliverable is ABOUT — its `## ` section headings.
 *
 * Handed to the discovery pass as the disambiguator for a namesake. A spawned thread inherits its
 * parent's QUESTION, which routinely names the subject only by acronym ("AISI's computing
 * resources"), and an acronym is exactly where collisions live: #3644 searched it cold and opened
 * UC Irvine's institute instead of the Chinese one its parent had researched.
 */
function priorOrgsIn(docBody, { max = 20 } = {}) {
  const out = [];
  for (const chunk of String(docBody || '').split(/^##\s+/m).slice(1)) {
    const h = chunk.split('\n')[0].replace(/\s+/g, ' ').trim().replace(/[*_`]/g, '');
    if (h.length >= 3 && h.length <= 120 && !out.includes(h)) out.push(h);
    if (out.length >= max) break;
  }
  return out;
}
function priorSectionFor(docBody, targetName, { maxChars = 2500 } = {}) {
  const body = String(docBody || '');
  const want = _norm(targetName);
  if (!body.trim() || want.length < 3) return null;
  const wantToks = new Set(want.split(' ').filter((w) => w.length >= 4));
  let best = null, bestScore = 0;
  for (const chunk of body.split(/^##\s+/m).slice(1)) {
    const heading = _norm(chunk.split('\n')[0]);
    if (!heading) continue;
    // EXACT OR CONTAINMENT ONLY — token overlap is NOT enough, and this was proved live.
    //
    // A spawned thread drifted to a NAMESAKE: #3640 researched the Chinese "AI for Science
    // Institute (AISI)", and its follow-up #3644 opened "UCI Artificial Intelligence in Science
    // Institute (AISI)" — University of California, Irvine. The two names share three tokens
    // (science · institute · aisi), which cleared the two-shared-words bar, so this function handed
    // the CHINESE institute's 2,513-character section to a run about the AMERICAN one, labelled as
    // already established. Cross-contamination between two real organizations, in the one channel
    // whose whole promise is "treat this as GIVEN".
    //
    // Shared generic words cannot carry organizational identity — "science", "institute",
    // "research", "national" are what org names are MADE of, and an acronym is exactly where
    // collisions live. So the heading must be the same name or literally contain it. The true
    // positives are unaffected because a legitimate target name came from this very document's own
    // discovery pass and matches it exactly.
    let hits = 0;
    for (const t of new Set(heading.split(' '))) if (wantToks.has(t)) hits++;
    let score = 0;
    if (heading === want) score = 100;
    else if (hits >= 2 && (heading.includes(want) || want.includes(heading))) score = 50 + hits;
    if (score > bestScore) { bestScore = score; best = chunk; }
  }
  if (!best) return null;
  const text = ('## ' + best).trim();
  return text.length > maxChars ? text.slice(0, maxChars) + '\n…(truncated)' : text;
}

/**
 * ⭐ A SPAWNED THREAD INHERITS ITS PARENT RUN'S DELIVERABLE — by LINEAGE, not by matching.
 *
 * Measured 2026-07-31, minutes after it happened: #3640 concluded, wrote a 43,324-character
 * deliverable on China's AI-materials institutes, and spawned three follow-up threads — "what is
 * AISI's annual budget and funding sources", "what is the quantitative scale of its compute",
 * "who holds the top executive role". #3643 went ACTIVE and began researching AISI from scratch
 * while the document covering AISI sat right there, written six minutes earlier.
 *
 * Every spawned thread measured had base_doc=NONE (8 of 8, across three different parents),
 * because base_doc was only ever set on the user-work driver's path — the one that handles LUCAS's
 * threads. A thread the program spawned for itself could never get one.
 *
 * This is the case the topic-MATCHING approach was built for and kept missing: the living-doc
 * matcher fires on roughly 1 research thread in 18, because guessing which of 92 deliverables
 * covers a topic is genuinely hard. But a spawned thread does not need guessing. It has its
 * parent's id. The deliverable is stored at the derivable ref `directed-<parentId>`, so the link
 * is a lookup, not a heuristic — the same lesson the civic store learned the expensive way: where
 * a real lineage exists, use it, and never reach for fuzzy matching beside it.
 *
 * Returns the parent deliverable's doc id, or null. Null is the correct and common answer: a
 * subconscious-born thread carries `spawned_from='subc'` (no parent RUN, so nothing to inherit),
 * and a parent that never landed a deliverable has nothing to give.
 */
function inheritedBaseDocId(threadId, { deps = {} } = {}) {
  const db = deps.db || require('./db');
  let parent = null;
  try { parent = db.getMeta(`thread.${Number(threadId) || 0}.spawned_from`); } catch { return null; }
  const pid = String(parent == null ? '' : parent).trim();
  if (!/^\d+$/.test(pid)) return null;                       // 'subc' and friends: no parent run
  if (Number(pid) === Number(threadId)) return null;         // a thread cannot inherit from itself
  try {
    const doc = db.getDocumentByRef(`directed-${pid}`);
    return doc && doc.id ? { docId: doc.id, parentId: Number(pid), title: doc.title || '' } : null;
  } catch { return null; }
}

// THE LIVING DOCUMENT (Lucas 2026-07-30: "a concept built as an actionable living document —
// the task bounces off that document over time"): match a new research thread to an EXISTING
// landed research doc so the run CONTINUES it instead of restarting at zero. Same 2-token topic
// rule as news vigilance (one shared word is coincidence, two is a topic); research-source docs
// only; newest wins ties. Null = genuinely new ground → a fresh document is right.
function matchDocToTopic(topic, docs) {
  const toks = threadTokens(topic);
  if (toks.size < 2) return null;
  let best = null, bestHits = 0;
  for (const d of (Array.isArray(docs) ? docs : [])) {
    if (!d || (d.source && d.source !== 'research')) continue;
    const text = `${d.title || ''} ${String(d.markdown || '').slice(0, 4000)}`.toLowerCase();
    let hits = 0;
    for (const t of toks) { if (text.includes(t)) hits++; }
    if (hits < 2) continue;
    if (hits > bestHits || (hits === bestHits && (d.openedAt || 0) > ((best && best.openedAt) || 0))) { best = d; bestHits = hits; }
  }
  return best;
}

// The living-document CANDIDATE POOL. The recency window alone starves the anchor — measured on
// boot128, the newest-40 docs were 100% news/inquiry/browser_download and the 15k grid dossier
// (two days old) could never match, so #3617 seeded blind. Union the recency window with
// per-token recall over the WHOLE store; searchDocuments is whole-string LIKE, so recall must
// ride one token at a time, never the full sentence.
function docPoolForTopic(topic, { candidates = () => [], recall = () => [] } = {}) {
  const pool = [].concat(candidates(40) || []);
  for (const t of [...threadTokens(topic)].slice(0, 8)) pool.push(...(recall(t, 8) || []));
  return pool;
}

// PARK-LANDING: a stopped or preempted user run must still enter the living-document pool.
// Only the condense path (run COMPLETION) landed the deliverable, and his biggest research is
// exactly the kind that gets stopped mid-flight — directed-3618 accreted 15k across days of
// passes and was invisible to the next seed. Beat foci re-derive from the sweep and stay out.
// land() is idempotent on ref+body, so repeated stops of an unchanged deliverable are free.
function parkDeliverable({ focusId, reason = 'parked', readFile = () => null, getMeta = () => null, getThread = () => null, land = () => null } = {}) {
  if (!focusId) return null;
  if (String(getMeta(`focus.${focusId}.beat`) || '').trim()) return null;
  const r = readFile(`notes/directed-${focusId}.md`);
  const body = (r && r.text) || '';
  if (String(body).trim().length < 400) return null;   // a header-only shell isn't a living document
  let goal = ''; try { const t = getThread(focusId); goal = (t && t.content) || ''; } catch { /* title falls back below */ }
  const dl = land({ title: `Research — ${String(goal || `directed run #${focusId}`).slice(0, 100)}`, body, source: 'research', ref: `directed-${focusId}`, understanding: String(goal).slice(0, 300) });
  return (dl && dl.landed) ? { id: dl.id, reason } : null;
}

// Per-pass guidance addenda: related news (so the working story stays current) + deadline pacing
// (an hour left means ASSEMBLE, six hours means depth that finishes inside the window).
function augmentGuidance(guidance, { focusId, content, createdTs, getMeta = () => null, now = 0 } = {}) {
  const parts = [String(guidance || '').trim()];
  try {
    const news = JSON.parse(getMeta(`thread.${focusId}.news_recent`) || '[]') || [];
    if (news.length) {
      parts.push('RELATED NEWS (working-topic vigilance — fold anything that changes the picture into THIS pass, and cite the story):\n'
        + news.slice(0, 5).map((h) => `- ${h.title}`).join('\n'));
    }
  } catch { /* vigilance is additive, never blocking */ }
  const dl = parseDeadline(content, createdTs);
  if (dl && dl.dueTs) {
    const mins = Math.round((dl.dueTs - now) / 60000);
    if (mins <= 0) parts.push('DEADLINE: PASSED — stop hunting. Assemble the best available answer NOW from what is gathered; name the gaps plainly.');
    else if (dl.kind === 'rush') parts.push(`DEADLINE: ~${mins} minutes left — ASSEMBLE the best available answer; cite what you have, name what's missing, do NOT keep hunting for perfection.`);
    else parts.push(`DEADLINE: about ${Math.max(1, Math.round(mins / 60))}h left — pace the depth to finish INSIDE the window with a complete draft.`);
  }
  return parts.filter(Boolean).join('\n\n');
}

// REDIRECT DETECTION (turn 10275, 2026-07-30: "I would honestly rather have you focus on the
// China AI and materials research" → she SAID "I'm pivoting focus" and NOTHING registered — no
// thread, no park; the driver rolled on. The pivot must be CODE, not a promise). Conservative
// by design (the directives over-capture warning): preference/imperative shapes only — a
// question never fires, and bare "work on" never fires (direction grid: HIS work is not a
// redirect of HERS).
const _REDIRECT_RES = [
  /\bi(?:'d| would)(?: honestly| really)? rather (?:have you |you )?(?:focus|work) on\s+(.{4,140}?)(?:\s+(?:instead|for now|next))?[.!]?\s*$/i,
  /(?:^|[.!?]\s+)(?:please\s+)?(?:focus on|switch to|pivot to|prioriti[sz]e)\s+(.{4,140}?)(?:\s+(?:instead|for now|next))?[.!]?\s*$/i,
  /\blet'?s focus on\s+(.{4,140}?)(?:\s+(?:instead|for now|next))?[.!]?\s*$/i,
];
function detectRedirect(message) {
  const t = String(message || '').trim();
  if (!t || /\?\s*$/.test(t)) return null;                              // a question is not a redirect
  for (const re of _REDIRECT_RES) {
    const m = re.exec(t);
    if (m) {
      const topic = m[1].replace(/^(?:the\s+)+/i, '').replace(/\s+/g, ' ').trim();
      if (topic.length >= 4 && !/^(it|that|this|them|him|her)$/i.test(topic)) return { topic };
    }
  }
  return null;
}

// THE CLASSIFIER IS PRIMARY, THE REGEX IS FALLBACK (detectors-vs-comprehension, proven AGAIN the
// same hour the regex shipped: "pivot your attention to the AI…", "move to the china research",
// "Complete any research related to China first" — three real steering phrasings, zero fired.
// Enumerating surface forms fails identically in JavaScript or English; the prompt states the
// DISTINCTION). Wide cheap trigger → cloud classify → regex only when the cloud is unreachable.
// RE-LOOK verbs added 2026-08-06 (measured live: "can you take another look at the Hartfield and
// Green South report" fired NOTHING — the P4b acceptance-test turn never reached the classifier).
const REDIRECT_TRIGGER_RE = /\b(pivot|shift|switch|move|focus|prioriti[sz]e|rather|instead|first|concentrate|complete|finish|revisit|re-?examine|rework|another look|look (?:at\b[^.?!]{0,60}?)?again|go (?:back )?over)\b/i;
function buildRedirectAsk(message) {
  return {
    task: 'redirect_intent', v: 1, think: false,
    input: { message: String(message || '').slice(0, 800) },
    want: `Lucas is talking to his research assistant, who has a live working focus. Decide: is he STEERING WHAT SHE WORKS ON — changing or ordering HER research/working focus? ANY phrasing counts ("pivot your attention to X", "move to the X research", "complete X first", "I'd rather you focus on X", "switch to X", "take another look at the X report" — sending her BACK to finished or in-flight work is steering too). It is NOT steering when he asks a question, plans HIS OWN work ("I'll work on the deck"), or narrates the past.
Reply ONLY: {"redirect": true|false, "immediate": true|false, "topic": "<the work he steered her toward, in his words — empty when redirect is false>"}
immediate=true when the new topic should take over NOW; immediate=false when he queued it AFTER current work ("finish Y first, then X").`,
    validate: (raw) => {
      try {
        const m = String(raw || '').match(/\{[\s\S]*\}/);
        if (!m) return { valid: false, error: 'no JSON object' };
        const o = JSON.parse(m[0]);
        if (typeof o.redirect !== 'boolean') return { valid: false, error: 'redirect must be true|false' };
        const topic = String(o.topic || '').replace(/\s+/g, ' ').trim().replace(/^(?:the\s+)+/i, '').slice(0, 140);
        if (o.redirect && topic.length < 4) return { valid: false, error: 'a redirect needs a real topic' };
        return { valid: true, value: { redirect: o.redirect, immediate: o.immediate !== false, topic } };
      } catch (e) { return { valid: false, error: e.message }; }
    },
  };
}

// Match a redirect topic to an EXISTING thread (any live status — an already-driven thread can
// be re-promoted) by the same 2-token topic rule as news vigilance. Null = genuinely new topic.
function matchThreadToTopic(topic, threads) {
  const toks = threadTokens(topic);
  if (toks.size < 1) return null;
  let best = null, bestHits = 0;
  for (const t of (Array.isArray(threads) ? threads : [])) {
    const tt = threadTokens(t && t.content);
    let hits = 0;
    for (const w of tt) if (toks.has(w)) hits++;
    if (hits >= 2 && (hits > bestHits || (hits === bestHits && (t.created_ts || 0) > ((best && best.created_ts) || 0)))) { best = t; bestHits = hits; }
  }
  return best;
}

// DEFERRED-AGENDA CAPTURE (chat audit 10278/10280, 2026-07-30: "Save that elections news for
// next week's Rainey team meeting" → she said "saved / will be on the agenda" and NOTHING
// registered — no note, no task, no track. A hold-for-later ask must become a REAL row on her
// own clock. Classifier-primary, same contract as the redirect; the recent turns ride the input
// so "that" resolves to what was actually being discussed.
const AGENDA_TRIGGER_RE = /\b(remind|agenda|meeting|next (?:week|month)|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|save (?:that|this|it)|bring (?:that|this|it|up)|keep (?:that|this|it)|flag (?:that|this|it)|later)\b/i;
function buildAgendaAsk(message, context = '') {
  return {
    task: 'agenda_intent', v: 1, think: false,
    input: { message: String(message || '').slice(0, 800), recent_turns: String(context || '').slice(0, 900) },
    want: `Lucas is talking to his research assistant. Decide: is he asking her to HOLD something for a FUTURE moment — save/bring up/remind/flag an item for a later meeting, day, or event? It is NOT a hold when he asks a question, gives an immediate task, or just mentions a meeting in passing.
Reply ONLY: {"defer": true|false, "item": "<WHAT to hold, resolved from the recent turns — a concrete phrase, not 'that'>", "when": "<his words for when>", "days": <estimated days from now until it's needed, e.g. 7 for next week>}
When defer is false, item/when may be empty and days 0.`,
    validate: (raw) => {
      try {
        const m = String(raw || '').match(/\{[\s\S]*\}/);
        if (!m) return { valid: false, error: 'no JSON object' };
        const o = JSON.parse(m[0]);
        if (typeof o.defer !== 'boolean') return { valid: false, error: 'defer must be true|false' };
        const item = String(o.item || '').replace(/\s+/g, ' ').trim().slice(0, 240);
        if (o.defer && (item.length < 6 || /^that\b/i.test(item))) return { valid: false, error: 'a hold needs a CONCRETE item (resolve "that" from the recent turns)' };
        const days = Number(o.days);
        return { valid: true, value: { defer: o.defer, item, whenText: String(o.when || '').slice(0, 80), days: isFinite(days) ? days : 7 } };
      } catch (e) { return { valid: false, error: e.message }; }
    },
  };
}

module.exports = { RESEARCH_RE, isResearchShaped, parseDeadline, threadTokens, matchNewsToThread, matchDocToTopic, docPoolForTopic, inheritedBaseDocId, priorSectionFor, priorOrgsIn, facetAppliesTo, parkDeliverable, scoreThread, pickUserThread, augmentGuidance, detectRedirect, matchThreadToTopic, REDIRECT_TRIGGER_RE, buildRedirectAsk, AGENDA_TRIGGER_RE, buildAgendaAsk };
