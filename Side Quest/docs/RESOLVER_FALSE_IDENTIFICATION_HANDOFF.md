# Handoff — the resolver is recording false claims about real people

**Status:** DIAGNOSED, NOT FIXED. Found by live audit 2026-07-21 at Lucas's direction
("live audit Zoe right now and take a look at how the meeting is being processed").
**Severity: high.** The system is currently asserting employment and board memberships
for named, identifiable public figures that are not true, and it destroys the evidence
that would let anyone notice.

---

## 1. The reproduction

`doc:7477` — Alcona County, Michigan Board of Commissioners organizational minutes,
`https://alconacountymi.com/.../1-02-25-Organizational-Meeting-Minutes.pdf`,
ingested 2026-07-21T13:07:03Z. The document says:

> "The Organizational Meeting of the Alcona County Board of Commissioners was held in the
> County Building in the City of Harrisville, Michigan on Thursday, January 2, 2025…
> Commissioners present: **Carolyn Brummund**, **Adam Brege**, David Jagst, Craig Johnston
> and Terry Small."

What is now in `encounters`:

| object_label | claim | value |
|---|---|---|
| `BOURDEAUX, CAROLYN [H8GA07201]` | structural / member_of | Alcona County Board of Commissioners |
| `Adam Frisch [FEC:H2CO03351]` | structural / member_of | Alcona County Board of Commissioners |

Carolyn Bourdeaux is a **Georgia** congressional candidate. Adam Frisch is **Colorado**.
The strings "Bourdeaux" and "Frisch" **do not occur anywhere in the 17,968-character
document** — verified by direct substring search. The binding was made on FIRST NAME.

**No commissioner was recorded correctly.** Checked each:

```
Brummund → MORGAN BRUMMUND [lda_lobbyist:152559]   (a different person)
Brege    → Hannah Brege                            (a different person)
Jagst    → absent entirely
Johnston → Mollie Johnston                         (a different person)
Small    → matched NEWS EVENTS ("…give small reprieve for July 4th…")
Eller    → Michael Keller                          (surname is also wrong)
```

---

## 2. The trace — where the substitution happens

**The extractor is innocent.** `kg_observations` for this document holds the correct
surface names, including the correct edge:

```
Stephany Eller · David Jagst · Craig Johnston · Terry Small · Cheryl Franks   (all type=person)
Carolyn Brummund -[MEMBER_OF]-> Alcona EDC Board                              ✓ correct
```

The same lane also wrote `BOURDEAUX, CAROLYN [H8GA07201] -[MEMBER_OF]-> Alcona County Board
of Commissioners`. So the corruption is downstream of extraction, in resolution.

The chain, exactly:

```
main.js  decomposeLandedDoc
  resolve = (name, opts) => resolution_gate.preResolve(name, opts,
                              { deps, fallback: echo_suit.resolveMention })
      │
lib/doc_decompose.js:208    r = await resolve(name, { preferType, context })
lib/doc_decompose.js:210    if (status === 'resolved')
                              return { action:'reuse', name, type, object:r.object,
                                       canonical: (r.object && r.object.name) || name }
                                       ▲▲▲ THE SURFACE NAME IS DISCARDED HERE
lib/doc_decompose.js:468    usable.set(key, d.canonical || d.name)
lib/doc_decompose.js:527-8  sName = usable.get(...)   tName = usable.get(...)
lib/doc_decompose.js:557    _observe({ sourceEntity: sName, relation, target: tName, … })
      │
main.js  observe()  →  curationStore.record()  → kg_observations
                    →  decomp_encounters.toEncounter() → encounters
```

`canonical` is the RESOLVED entity's name. From line 210 onward the document's own wording
is gone and every downstream store receives the resolver's opinion as if it were the text.

---

## 3. Why the existing guard does not fire

`lib/entity_match.js` — the precision matcher built specifically to stop the Howell false
merge and the LAMP fan-out — **already refuses both of these**:

```js
matchPair({name:'Carolyn Brummund'}, {name:'BOURDEAUX, CAROLYN [H8GA07201]'})
  → { decision:'no-match', tier:'gate', reason:'given-name-conflict' }

matchPair({name:'Adam Brege'}, {name:'Adam Frisch [FEC:H2CO03351]'})
  → { decision:'no-match', tier:'gate', reason:'surname-differs' }
```

It is never consulted on this path. `lib/resolution_gate.js:81 preResolve` is **add-only by
construction**, and says so in its own header:

> "the gate only ever ADDS a confident merge — it can never regress the existing resolver"

On any non-merge it falls through to `echo_suit.resolveMention`. So the refusal is computed
and then discarded — the gate can approve a binding but has no power to veto one.

**This is the recurring shape of every defect found this month: the capability exists,
correct and tested, and the hot path does not call it.** (Same as `type = 'concept'` being
a default nobody passed; same as `recordRelation` minting endpoints with no source.)

---

## 4. A written contract is being violated

`lib/db.js:489`, describing the encounters schema:

> `object_key` identity, normalised — what merges. **`object_label` keeps what the SOURCE
> called it, which is evidence and must survive resolution.**

It does not survive. `object_label` holds `BOURDEAUX, CAROLYN [H8GA07201]`; the document
said `Carolyn Brummund`. Because the substitution happens upstream of the log, the surface
form is **not recorded anywhere** — not in `encounters`, not in `kg_observations`.

Consequence: this class of error is undetectable after the fact. It was only found because
the source PDF body was still in `documents` and could be searched. Any fix should treat
retaining the surface form as part of the fix, not a nicety.

---

## 5. Blast radius (measured, 2026-07-21)

**104 distinct federal-ID-tagged people carrying 122 false local structural claims.**

```
AMASH, JUSTIN [H0MI03126]      → Lupin Limited        (fuzzy hit on the word "Amish")
AMASH, JUSTIN [H0MI03126]      → VIFOR PHARMA LTD
AGUILAR, PETE [H2CA31125]      → Commercial Office of Mexico
BANKS, JAMES E. HON. [S4IN00196] → City of Nicholls
BIRMAN, IGOR A [H4CA07055]     → Boston Medical Center
Amish Dr. Shah [FEC:H4AZ01194] → Lupin Limited / Crawford Bayley & Co.
BOURDEAUX, CAROLYN [H8GA07201] → Alcona County Board of Commissioners
Adam Frisch [FEC:H2CO03351]    → Alcona County Board of Commissioners
```

Query to reproduce the list:

```sql
SELECT object_label, claim_value, COUNT(*) FROM encounters
 WHERE claim_class='structural' AND claim_key IN ('member_of','works_for','leads')
   AND (object_label LIKE '%[FEC:%' OR object_label GLOB '*\[[A-Z][0-9][0-9][0-9][0-9][0-9][0-9]\]*')
 GROUP BY 1,2;
```

This is a floor, not a ceiling: it only counts people carrying a *federal* strong ID. Bindings
onto ordinary names (Brummund → MORGAN BRUMMUND, Eller → Michael Keller) are not counted and
are almost certainly more numerous.

---

## 6. Proposed fix

**A precision REFUSAL must veto. Today it merely fails to add.**

### 6a. The one-line-shaped change

`lib/doc_decompose.js:210`, in `resolveExtracted`. Before accepting `action:'reuse'`,
verify the resolver's answer against the surface name:

```js
if (status === 'resolved') {
  const cand = r.object && r.object.name;
  // A resolver answer is a PROPOSAL. entity_match is the precision gate that already knows
  // Carolyn Brummund is not Carolyn Bourdeaux; consult it before adopting a canonical name.
  if (cand && cand !== name) {
    const verdict = require('./entity_match').matchPair(
      { name, type: preferType }, { name: cand, type: preferType });
    if (verdict.decision === 'no-match') {
      return { action: 'mint', name, type, reason: `resolver-rejected:${verdict.reason}` };
    }
  }
  return { action: 'reuse', name, type, object: r.object, canonical: cand || name };
}
```

Return `mint` (or `hold`) rather than silently keeping the surface name as an alias of the
wrong node — the point is that this is a DIFFERENT person, so it should become its own object
or be held, never merged.

**Decide deliberately between `mint` and `hold`.** `mint` gets the real commissioners into the
graph (currently they are simply absent, which is its own failure). `hold` is more conservative
but leaves the meeting unrepresented. Recommendation: `mint`, because the extractor's full name
("Carolyn Brummund") is a STRONG reference by F1's own definition and mint-reluctance was
designed to block bare first names, not full names.

### 6b. Retain the surface form regardless

Even where the merge is legitimate, `_observe` should carry the surface name so `object_label`
can honour its contract. Minimal shape: add `surfaceName: name` to the observation objects at
`doc_decompose.js:557` and `:486`, and have `decomp_encounters.toEncounter` prefer it for
`object_label` while `object_key` keeps using the canonical. That restores "evidence must
survive resolution" without changing what merges.

### 6c. Record the 122 as known-incorrect

`lib/known_incorrect.js` exists for exactly this ("a refuted claim stays, marked" — and
`record()` requires a reason, so the rationale is preserved). Recording these prevents the
same binding from quietly re-landing on the next sweep. They must NOT simply be deleted: the
encounter log is append-only by design, and deleting is what lets a bad datum walk back in.

---

## 7. How to verify the fix (do not trust a green suite)

Every real defect this month was caught by measuring live, never by a passing test.

1. **Unit** — add to `scripts/smoke_doc_decompose.js`: a resolver stub returning
   `{status:'resolved', object:{name:'BOURDEAUX, CAROLYN [H8GA07201]'}}` for the input
   `Carolyn Brummund` must NOT produce `action:'reuse'`.
2. **Live replay** — re-decompose `doc:7477` and assert that `encounters` gains
   `Carolyn Brummund` and `Adam Brege` and gains NO row whose `object_label` contains
   `BOURDEAUX` or `Frisch`.
3. **Regression sweep** — re-run the §5 query; the count must not grow.
4. **Watch the counter-risk** — this change makes the resolver mint more. Track
   `out.minted` vs `out.reused` on the decompose lane before/after; a large swing toward mint
   means the gate is too strict and is fragmenting real entities. That is the failure mode to
   watch for, and it is the reason `preResolve` was made add-only in the first place.

---

## 8. Pitfalls (learned the hard way this session)

- **Do not "fix" this with a name regex.** Name rules over-match: an institution regex written
  this week matched `n\.?a` inside Bren-**na**, A-**nna**, Ro-**na**-ld; a host rule read
  `team.georgia.gov` as **Iowa** because georg-**ia** ends in a state code. Use
  `entity_match`, which is tested and reasons about given name vs surname explicitly.
- **Do not bulk-delete the 122.** Append-only is the design; mark them refuted instead.
- **Count what you are actually changing.** Two reports this month were wrong because a JOIN
  fanned out the row count. Report the number of *bindings changed*, verified against a
  before/after query.
- **Make the books balance.** A pass that reports "N fixed" without accounting for the
  remainder reads as success while hiding the finding — that is how 250 silently-dropped
  Wikidata lookups looked like a clean run.

---

## 9. Second finding from the same audit (separate, smaller)

**2,662 encounters are graded `authority='unknown'` because US county and city governments
routinely use `.com`/`.org` domains.** The rule in `lib/decomp_encounters.js` (and mirrored in
the news/meeting lanes) is `/(^|\.)(gov|mil)$|\.us$/`.

```
allencounty.org       719      cityclerk.lacity.org  412   ← the Los Angeles City Clerk
atkinsoncounty.org    609      alconacountymi.com    241
southcounty.org       288      applingcountyga.org   114
```

These are official records receiving zero authority weight, so their claims cannot reach the
grade needed to settle. Relates to the existing open item "promotion gate + official-doc
weight" (single-source .gov caps at B=0.88 < floor 0.90).

**Do not fix this with a "hostname contains county" rule.** The same set contains
`alconacountyfair.com` (a county *fair*) and `countynewscenter.com` (a news site). A curated
registry of known government hosts, or a claim graded by the document's own letterhead, is the
honest path.

This also explains why the birth-context rough edge (`lib/birth_context.js`) did not catch the
Alcona case: `alconacountymi.com` yields no jurisdiction, so there was no Michigan prior with
which to contradict a Georgia candidate. Fixing government-host recognition would give the
rough edge real teeth on exactly this failure.

---

## 10. Ownership / lane notes

- `lib/doc_decompose.js`, `lib/resolution_gate.js`, `lib/entity_match.js`,
  `lib/decomp_encounters.js`, `lib/known_incorrect.js` — all in Side Quest, all fair game.
- **`main.js` belongs to the interface context.** The fix above does NOT require touching it;
  the insertion point is in `doc_decompose.js`.
- `echo_suit.resolveMention` dispatches into Echo (`nx-echo`). **Changing Echo needs Lucas's
  explicit sign-off**, and `nx-echo` currently carries his own uncommitted work. The proposed
  fix deliberately sits on the Side Quest side of that boundary and requires no Echo change.
- The app is running; the decompose lane is active and producing this daily. A reboot is
  request-only.
