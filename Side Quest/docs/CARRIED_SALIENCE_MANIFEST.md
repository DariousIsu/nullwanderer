# Carried-Salience Manifest — spec (2026-08-10)

**Origin.** Live transcript: "who is the mayor of Shreveport?" → "Tom Arceneaux." → "have we found
**his** contact info?" → non-answer ("the person in question"), misroute, bare promise. With the
explicit name the identical request works perfectly. So the contacts lane is fine — **reference
resolution against recent history is the failure**, and it is one disease, not a pronoun bug.

## 1. The disease (one, not four)

`lib/referent.js` is a growing pile of **per-phrasing regex nets**: elliptical follow-ups (2026-07-20),
demonstratives "that story" (2026-07-26), and pronouns would be the next net. Each catches one *way of
pointing* at the thing under discussion. That file existing and growing IS the smell (whack-a-mole →
the merge).

The structural root, traced through the code:

1. **The manifest resolves each turn in near-isolation.** `manifest.buildManifest(text, {context})`
   (main.js:9078) passes only the last 4 turns, and inside only `context.slice(0,400)` reaches
   `intake.decompose` as a prose hint. It resolves *this message's* named mentions; it does not
   dereference references to *prior* turns' resolved coordinates.
2. **Unresolved → mint a NEW empty coordinate.** `assembleManifest` sends anything not resolved to
   `STATUS.MINTED_NEW` → the gap set. So "his" becomes a brand-new empty `person:` coordinate the
   model narrates as *"the person in question"* — instead of dereferencing the `Tom Arceneaux`
   coordinate that was resolved **one turn ago**.
3. **The manifest is discarded after the turn.** `_man` is built, rendered into `references`, used to
   warm gaps, then dropped. **No salience is carried forward.** There is no "who/what is on the table."
4. **The gate is a capital-letter regex.** main.js:9073 fires the manifest only when
   `_namesSomething` (`/[A-Z][A-Za-z…]+/`) or a meeting word matches. **A pronoun-only turn
   ("have we found his contact info?") has no capital letter, so it never enters the coordinate
   system at all.** referent.js then patches a *few* such turns at the prose-retrieval layer, but only
   the phrasings someone wrote a net for.

Net: recent conversation is treated as **retrievable ambient prose**, not as a **resolved discourse
state**. References are pattern-matched, not dereferenced.

## 2. The principle

> Recent conversation is a **resolved discourse state**. A reference ("his", "that list", "the full
> one", "pull it up") is a **coordinate dereference against carried salience** — never a pattern match.

The model already does the linguistic judgment (it reads the turns and knows "his contact info" wants a
*person*). The structural move is to (a) **carry** the recently-resolved coordinates, and (b) let the
model **flag** a mention as referential + typed, so **code does a deterministic keyed dereference**
against the carried frame. No word-lists, no phrasing nets.

## 3. The design

### 3a. The salience frame (the carried state) — `lib/salience.js` (new, pure)
A per-session, ordered, recency-decayed set of the coordinates recently on the table:

```
{ coord, type, surface, gloss, lastTurn, hits }   // e.g. person:civic/12345 "Tom Arceneaux"
```

- **Update:** after each turn's manifest resolves, `salience.fold(sessionId, manifest.objects)` merges
  resolved (non-gap) objects in — bump `lastTurn`/`hits` for repeats, insert new, **evict beyond a cap
  (~8) by recency**. Minted gaps do NOT enter (only *resolved* things are antecedents).
- **Decay:** recency-ordered; a newer salient entity supersedes an older one of the same type. Topic
  shift falls out naturally as new coordinates push old ones past the cap.
- **Persistence:** in-memory per session is enough for the hot path; optionally checkpoint alongside
  `convo_state` (which already persists the *prose arc* per session — the frame is its *entity-level*
  complement: convo_state = "what we're doing", salience = "who/what the pronouns point at").
- Pure functions (`fold`, `dereference`, `topOfType`) with the store injected — offline-smokeable, the
  same split `manifest.js` uses (pure `assembleManifest` vs I/O `buildManifest`).

### 3b. Referentiality from the model, dereference in code (NO regex)
Extend the `intake.decompose` contract (a prompt change, not a regex): a mention that **points at
something already in the discourse** is emitted with `ref: true` and the `type` it wants:

```
{ mention: "his", ref: true, type: "person" }          // "his contact info" wants a person
{ mention: "that list", ref: true, type: "document" }  // "pull that up" wants the salient artifact
{ mention: "it", ref: true, type: null }               // untyped → most-recent salient of any type
```

The model already sees the recent turns in `context`; recognizing "his" as referential and person-typed
is exactly the judgment it's good at. Then in `buildManifest`'s resolution loop, a `ref:true` mention
**bypasses civic/owner resolution AND minting** and instead:

```
const hit = salience.dereference(sessionId, { type: m.type });   // most-recent frame coord, type-compatible
```

- **Hit** → the mention takes that existing coordinate (`Tom Arceneaux`), `status: 'held'`, `salient`.
  The rendered manifest shows `"his" -> person:civic/12345 (Tom Arceneaux, salient)`, so the need-builder
  forms *"Tom Arceneaux's contact info"* and cognition/routing bind to the real entity.
- **No compatible antecedent** → it is an honest **gap with a clarify** ("which person do you mean?"),
  routed through the manifest's existing `clarify` channel — never a silent mint, never a guess.

Type-compatibility + recency is the whole heuristic. No gender matching (his/her/their all deref the
most-recent *person*); ambiguity between two salient people surfaces a clarify rather than guessing.

### 3c. The gate (main.js:9073) becomes discourse-aware, not capital-letter
Replace "fire only when a capital letter appears" with: **fire when the turn is a substantive
message AND (it names something OR a salience frame is active).** So a pronoun-only follow-up enters
the coordinate system whenever there's something on the table to point at. Keep the cost guard — pure
assent ("ok thanks") still pays nothing — but base "is this substantive" on `decompose`'s own
chat/intent judgment, not a word-list. (If cost matters, the cheap pre-check is "frame is non-empty and
message isn't pure backchannel," which the arc lane already computes.)

### 3d. `referent.js` collapses into this
Elliptical + demonstrative + pronoun become **one operation**: dereference the current turn's
references against the salience frame. The three nets and the retrieval-suppression hack retire; the
*insight* they encode (a subjectless follow-up inherits the topic; a confident answer about the *wrong*
subject is the real failure) is preserved — implemented as typed frame-deref, not word-lists.

## 4. Why structural beats the regex

The space of referential phrasings is open — "his", "the guy", "that fella", "the mayor we just talked
about", "the second one". A regex net catches the phrasings you enumerated and bottlenecks on the rest
(and every miss reads as a fresh bug). The model already resolves reference from context for free; the
structural job is to (1) give it a **typed frame** to point into and (2) make the binding a **keyed
dereference**. New phrasings need no new code.

## 5. Boundaries / risks

- **Wrong antecedent** — mitigated by type-compatibility + recency + clarify-on-ambiguity. Never guess
  between two equally-salient people; ask (the manifest already has a `clarify` channel and the prompt
  already says "if you truly cannot tell, ASK").
- **Stale frame after a topic shift** — the recency cap + supersession handles it; a checkpoint should
  also expire on a long idle gap so yesterday's "him" doesn't bind today.
- **Cost** — the dereference is free; the gate change runs `decompose` on more follow-ups. Bound it to
  substantive turns with an active frame.
- **Frame vs owner-world** — owner-world resolution still wins for *named* mentions (Alice→daughter);
  the frame only governs *references*. A named mention refreshes the frame; it never reads from it.

## 6. Test shape (offline, structural)

- Seed a frame with `person:civic/…` "Tom Arceneaux"; decompose emits `{mention:"his", ref:true,
  type:"person"}`; assert deref binds that coordinate, `status:held`, **not minted**.
- Topic shift: fold a second person; "his" now binds the newer one (supersession).
- No compatible antecedent (frame holds only a *document*): person-ref → gap + clarify, **not mint**.
- Artifact-ref: "pull that up" with a salient `document:` coordinate → binds it (this is also the B3
  pull-up path — the same organ).
- Pure assent ("ok thanks") → no manifest, no frame mutation, pays nothing.

## 7. Landing order (small, verifiable steps)

1. `lib/salience.js` (pure frame: `fold` / `dereference` / `topOfType`) + smoke.
2. `intake.decompose` contract: emit `ref:true` + wanted `type` for referential mentions (prompt +
   validate) + smoke on the decomposer's shape.
3. `buildManifest`: fold resolved objects into the frame; deref `ref:true` mentions before mint.
4. main.js gate: discourse-aware fire; render shows the resolved referent.
5. Retire `referent.js`'s three nets once the frame path passes the same cases the nets covered.

Each step is independently gated by `npm test`; nothing lands live until the frame deref passes the
transcript case (pronoun contact-info) on the port.
