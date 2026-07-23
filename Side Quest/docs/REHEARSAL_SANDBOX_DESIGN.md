# The rehearsal ladder — self-repair/self-grow, staged (2026-07-22)

The write half of goal 4. Slice 3a gave her the read organs (source_map/read/search + self_test);
this ladder is how a CHANGE ever happens — and the whole design is that **she never edits her live
self**. Each rung is independently valuable; each later rung needs Lucas's explicit go.

## R0 — READ (✅ shipped, 5ad01cd)
Source self-access + the gate self-test. "How am I coded / am I healthy" — grounded, jailed
(data/, .env*, logs, node_modules unreachable by name).

## R1 — REHEARSE (built with this doc; zero adoption surface)
A sandbox is a **copy, so it parallels anything** (the concurrency rule: sandbox ∥ everything).

- `lib/rehearsal.js`: `create` copies the SOURCE allowlist (same jail as self_source) into
  `data/rehearsal/<slug>/` + junctions `node_modules`, so the offline gate runs inside it.
- `edit` is her first Edit primitive — exact-match find→replace, **inside the sandbox only**,
  refused if the find is absent or ambiguous (the same mechanical grounding contract my own harness
  enforces on me).
- `test` runs one suite or the full gate **with cwd = the sandbox** — the change is judged by the
  same oracle the build lane trusts, against the changed copy.
- `report` renders the honest artifact: unified diff + gate verdict + her rationale. `discard`
  deletes. Lifecycle bounds: ≤2 live sandboxes, stale ones (>48h untouched) auto-discard, every
  run registers on the workstream board (lane `rehearsal`).
- **No `adopt()` exists.** Nothing in R1 can write outside `data/rehearsal/`.

## R2 — PROPOSE (next; needs Lucas's go)
A finished rehearsal becomes a **proposal card**: diff + gate verdict + rationale + provenance,
landed in doc_store (`source 'rehearsal'`) + a canvas pointer — the same propose-semantics as KG
proposals and dedup queues. Lucas applies the diff through the build lane (review, gate, commit).
Autonomy may CHOOSE to rehearse (it's a read-class experiment on a copy), and a proposal card is
the only exit.

## R3 — ADOPT (design stance: code NEVER auto-adopts)
The only self-adopting substrate stays the one that already self-adopts with track records:
procedures (2c) and Echo recipe PROPOSALS. Program code crosses only through Lucas + the gate +
a commit. If that stance ever changes, it changes here first, in writing.

## Invariants (all rungs)
1. Live source is read-only to every model-reachable surface — forever.
2. The sandbox jail inherits self_source's: no data/, no .env*, no node_modules copies (junction
   only), and sandbox paths never resolve outside `data/rehearsal/<slug>/`.
3. The gate is the judge — no rehearsal "passes" on the model's say-so.
4. Everything registers on the board; everything is discardable; nothing is silent.
