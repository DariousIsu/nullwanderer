/* lib/decomp_encounters.js — a decompose observation becomes an ENCOUNTER (W2).
 *
 * docs/ENCOUNTER_OBJECT_MODEL_DESIGN.md §2/§5. The doc-decompose lane already extracts objects and
 * relations from every landed document and writes them to kg_observations. Those ARE encounters — the
 * same facts in a different shape, missing only claim class, source authority and the source's own
 * date. This translates one into the other so documents feed the graded substrate rather than a
 * parallel store.
 *
 * ── THE JUDGEMENT THIS MODULE MAKES: OBSERVABLE vs INTERPRETIVE (§5e) ───────────────────────────
 *
 * `WORKS_FOR`, `MEMBER_OF`, `LOCATED_IN` are checkable — a document either states them or it does not,
 * and someone could go and verify. `RELATED_TO` and `FOCUSES_ON` are NOT: they are a summariser's
 * judgement about what a document is about. Measured on the live corpus, that is 30,442 of 280,169
 * observations — 11% — which would otherwise be graded as fact.
 *
 * Lucas: "N sources characterize is a better concept to follow — everything can be true until proven
 * otherwise." So interpretive relations record how many sources characterised it that way, and never
 * carry a grade. Three summarisers reaching for the same word must not become a Grade-A fact.
 *
 * ── THE UNKNOWN-RELATION RULE ───────────────────────────────────────────────────────────────────
 *
 * The corpus holds 91 distinct relations, and the tail is entity names that leaked into the relation
 * slot: MIKADO, KAMALA_HARRIS, FRESNO, SCOTLAND. That is the relation-vocabulary sprawl already flagged
 * in the DB review. An unrecognised relation is a data-quality failure, not a new kind of edge, so it
 * is REFUSED rather than recorded as a structural fact. The entity's existence still lands — that part
 * was never in doubt.
 *
 * Pure. No db, no IO.
 */
'use strict';

// Checkable, in principle, by someone who goes and looks (§5d).
const STRUCTURAL = new Set([
  'WORKS_FOR', 'MEMBER_OF', 'LOCATED_IN', 'PART_OF', 'LEADS', 'RESPONSIBLE_FOR', 'PARTICIPATED_IN',
  'FUNDS', 'CREATED', 'REGULATES', 'ATTENDED', 'CITES', 'MET_WITH', 'APPOINTED', 'REPRESENTED',
  'SPONSORED', 'SPONSOR', 'FOUNDED', 'SUCCEEDS', 'PRECEDES', 'DISTRIBUTED', 'PARTNERED_WITH',
  'SIGNED', 'HOLDS_OFFICE', 'EXTENDS', 'RESOLVES',
  // Org-structural affiliation — "X is a c4 arm/sister/subsidiary of Y" is checkable, not a judgement.
  'AFFILIATE_OF', 'SUBSIDIARY_OF',
]);

// A fact about a person that accumulates and is never overwritten (§5b) — history, not current state.
const BIOGRAPHICAL = new Set(['HELD_OFFICE', 'OFFICE_HELD', 'BORN_IN', 'DIED_IN', 'PARENT_OF', 'MARRIED_TO']);

// A judgement, not an observation. NEVER graded as truth — see the header.
const INTERPRETIVE = new Set(['RELATED_TO', 'FOCUSES_ON', 'AFFECTS', 'SUPPORTS', 'OPPOSES', 'CLASSIFICATION']);

// The extractor's type vocabulary → the encounter log's object types. `other` stays unknown rather than
// being guessed into `thing`: the type is part of the identity key, so a wrong guess is a wrong merge.
//
// ── T1: A GOVERNMENT IS NOT A COMPANY ───────────────────────────────────────────────────────────
//
// This map used to fold `government_body` and `committee` into `org`, which is how a county board and a
// restaurant ended up the same kind of thing — Kent County Sheriff's office next to TWO GUYS FROM ITALY.
// The extractor ALREADY distinguishes them (live: organization 306 · government_body 51 · committee 25);
// only this map was throwing the distinction away.
//
// It matters beyond tidiness because a governing body DECLARES SEATS (§4) — that is what cardinality and
// coverage-gap detection key on. Filed under `org`, a county commission declares nothing and is
// invisible to gap detection. This is zero inference: it forwards the extractor's own call and guesses
// nothing.
//
// ONE VOCABULARY. `lib/ner.js` independently emits `organization`/`place`/`person`, so the conversation
// and recovery lanes must translate through here too — otherwise NER's `organization` and decompose's
// `org` become two objects for one thing, split exactly the way `place:`/`thing:apache county` was.
const TYPE_MAP = {
  person: 'person', organization: 'org', location: 'place', place: 'place', event: 'event',
  concept: 'concept', work: 'thing', bill: 'thing', document: 'document', office_held: 'thing',
  committee: 'body', government_body: 'gov', other: null,
  // Canonical values map to themselves so translating twice is a no-op — a lane that already speaks the
  // log's vocabulary must not be refused for it.
  org: 'org', gov: 'gov', body: 'body', thing: 'thing',
};

function claimClassFor(relation) {
  const r = String(relation || '').trim().toUpperCase();
  if (!r) return null;
  if (r === 'EXISTS') return 'existence';
  if (STRUCTURAL.has(r)) return 'structural';
  if (BIOGRAPHICAL.has(r)) return 'biographical';
  if (INTERPRETIVE.has(r)) return 'interpretive';
  return null;   // unrecognised → refused, see header
}

// Document lanes whose content is somebody TALKING. A transcript is a faithful record of speech, which
// makes it strong evidence about what was said and none about whether it is so.
const SPEECH_SOURCES = new Set(['meeting', 'transcript', 'media', 'video', 'conversation']);
const isSpeech = (source) => SPEECH_SOURCES.has(String(source || '').trim().toLowerCase());

// Identity is keyed on the CANONICAL name via the log's own key function, so this module and
// lib/encounters cannot disagree about what merges. Falls back to letting encounters derive the key
// if that module is unavailable — a missing key is recoverable, a WRONG key is a split object.
function objectKeyFor(type, label) {
  try { return require('./encounters').objectKey(type, label) || null; } catch { return null; }
}

function objectTypeFor(t) {
  const k = String(t || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(TYPE_MAP, k) ? TYPE_MAP[k] : null;
}

// One decompose observation → one encounter, or null if it should not be recorded.
//
// `doc` supplies the provenance the observation itself does not carry: the publisher, the content hash
// that makes independence computable, and the source's own date. Without those an encounter is
// permanently ungradeable, which is the whole failure this design exists to prevent.
function toEncounter(obs, doc = {}) {
  if (!obs || !obs.sourceEntity) return null;
  const claimClass = claimClassFor(obs.relation);
  if (!claimClass) return null;

  // An unresolved/held observation is a candidate, not an encounter. Recording it would let material the
  // pipeline itself declined to promote vote on a claim.
  if (obs.status && obs.status !== 'promoted') return null;

  // SPLIT IDENTITY IS THE FAILURE TO AVOID HERE, and it was caught on a live decompose. The type is
  // part of the identity key, so the same object arriving typed on its existence claim and untyped on
  // its edge becomes TWO objects: `place:apache county` and `thing:apache county`. Nothing downstream
  // can merge them, and every grade is then computed over half the evidence.
  //
  // So an edge whose subject type is unknown is REFUSED rather than filed under a fallback type. The
  // edge is recoverable — the document can be decomposed again — while a split identity quietly
  // survives forever. Defaulting to 'thing' is exactly the wrong trade.
  const type = objectTypeFor(obs.type);
  if (!type) return null;

  // V2 — IDENTITY IS CANONICAL, THE LABEL IS EVIDENCE. `lib/db.js:489`: object_key is "identity,
  // normalised — what merges", while object_label "keeps what the SOURCE called it, which is evidence
  // and must survive resolution".
  //
  // It did not survive. The resolver rewrote the surface name to the canonical one upstream, so a
  // Michigan county's minutes recorded `BOURDEAUX, CAROLYN [H8GA07201]` where the page said "Carolyn
  // Brummund" — and because the substitution happened before the log, the document's own wording was
  // stored NOWHERE. That is why the false-identification class was undetectable until someone read the
  // PDF by hand.
  //
  // Both are now set explicitly. The key must keep using the CANONICAL name or the fix would fragment
  // every legitimately-resolved object into one row per surface variant — trading a silent corruption
  // for a silent duplication.
  const canonicalLabel = String(obs.sourceEntity);
  const surfaceLabel = obs.surfaceSource != null && String(obs.surfaceSource).trim()
    ? String(obs.surfaceSource).trim() : canonicalLabel;

  return {
    object_type: type,
    object_key: objectKeyFor(type, canonicalLabel),
    object_label: surfaceLabel,
    claim_class: claimClass,
    claim_key: claimClass === 'existence' ? null : String(obs.relation).toLowerCase(),
    claim_value: claimClass === 'existence' ? null : (obs.target || obs.value || null),
    source_kind: 'document',
    source_ref: doc.id != null ? `doc:${doc.id}` : null,
    origin: doc.origin || null,
    origin_host: doc.origin_host || null,
    content_hash: doc.content_hash || null,
    // An official publisher substitutes for roughly one ordinary source (§6.3) — but only where the
    // origin is actually known. Most of the legacy corpus has none, and guessing invents authority.
    //
    // SPEECH IS NON-VALIDATING (W4). A meeting record is excellent evidence that someone SAID a thing
    // and no evidence at all that it is true. Without this, a meeting document decomposes down the same
    // path as a .gov roster and its claims land graded B and promoted — hearsay wearing a document's
    // authority. `stated` creates the object and carries zero evidentiary weight, exactly as Lucas
    // specified for conversation; the same reasoning applies wherever the source is a person talking.
    authority: isSpeech(doc.source) ? 'stated'
      : (doc.origin_host && /(^|\.)(gov|mil)$|\.us$/i.test(doc.origin_host) ? 'official' : 'unknown'),
    observed_at: Number.isFinite(doc.observed_at) ? doc.observed_at : null,
  };
}

// T3 — the same observation, read as a claim about WHAT KIND OF THING this is.
//
// The extractor's `entity_type` is an assertion by a source that can be graded like any other, and
// keeping it as a claim is what lets a county roster's `government_body` beat the LDA feed's
// `organization` later without a migration. The EXTRACTOR'S OWN VOCABULARY is recorded, not the log's
// coarser one: `government_body` and `committee` are the distinction being preserved, and folding them
// to `gov`/`body` here would discard exactly what T1 just stopped discarding.
//
// Authority comes from the PUBLISHER, never from the type asserted — a source must not be able to vouch
// for itself by claiming something official-sounding. Speech is non-validating for the same reason it is
// everywhere else (W4): a transcript proves what was said, not what is so.
//
// NOT YET WIRED INTO THE LIVE DECOMPOSE. Its only write site is main.js, which belongs to the interface
// context this session is not editing. lib/object_type.recordType(toTypeClaim(obs, doc)) is the one line.
// Until then T3 is fed by scripts/backfill_type_claims.js.
function toTypeClaim(obs, doc = {}) {
  if (!obs || !obs.sourceEntity) return null;
  const t = String(obs.type || '').trim().toLowerCase();
  if (!t || t === 'other') return null;                    // an untyped observation asserts nothing
  if (obs.status && obs.status !== 'promoted') return null;
  if (!objectTypeFor(t)) return null;                      // outside the known vocabulary → refused, not guessed
  return {
    label: String(obs.sourceEntity),
    type: t,
    sourceKind: 'document',
    sourceRef: doc.id != null ? `doc:${doc.id}` : null,
    origin: doc.origin || null,
    originHost: doc.origin_host || null,
    contentHash: doc.content_hash || null,
    authority: isSpeech(doc.source) ? 'stated'
      : (doc.origin_host && /(^|\.)(gov|mil)$|\.us$/i.test(doc.origin_host) ? 'official' : 'unknown'),
    observedAt: Number.isFinite(doc.observed_at) ? doc.observed_at : null,
  };
}

module.exports = { toEncounter, toTypeClaim, claimClassFor, objectTypeFor, isSpeech, STRUCTURAL, BIOGRAPHICAL, INTERPRETIVE, SPEECH_SOURCES, TYPE_MAP };
