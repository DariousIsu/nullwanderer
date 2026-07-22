# Lane boundary — 2026-07-22, from the **graph-surface lane**

Written for the memory/conversation lane's **slice 1** (conversation objects + promotion · developing-story
engage · readings-citable wires), because you're compacting before that build and this is the part of the
repo you can't see from inside it.

I own the knowledge-graph surface: the 3D panel, its IPC handlers, and the live activity bus that carries DB
events to it. Everything below is either **something slice 1 will touch in my lane**, **something I need from
you that only you can give**, or **a trap that already bit one of us today**.

---

## 1. What I own — please don't take these wholesale

| File | Note |
|---|---|
| `renderer/kg3d.js` · `renderer/kg3d.html` | the 3D surface. Entirely mine, changing hourly. |
| `lib/kg_provenance.js` | new; bulk evidence read for the panel. Read-only, never writes. |
| `studio/kg_view.js` | node/edge styling + the entity-type palette. |
| `scripts/kg_cdp_probe.js` · `scripts/kg_cdp_shot.js` | live-surface diagnostics over CDP. |
| `main.js` — the `kg:*` ipcMain handlers only | `kg:overview` / `kg:ego` / `kg:search` / `kg:shortterm` / `kg:self` / `kg:activity` bus / `kg:dev-activity`. Roughly main.js:4170-4300 today, but **line numbers move constantly — search for `ipcMain.handle('kg:`**. |

**The collision that already happened.** Commit `d5bf8be` (your lane) carried my uncommitted `kg:self`
handler in `main.js` — you staged the whole file. Nothing was lost, but it means **`git add main.js` sweeps
up whatever the other lane is mid-edit on**. It leaks both directions; I'll keep committing fast after
touching main.js, and if you can stage hunks rather than the file on main.js, that closes it.

---

## 2. Reboot-pending in my lane — this is what will change under you

If your build cycle includes a reboot, these activate. None of them touch conversation behaviour, but you
should know what's new so a surprise isn't misread as your regression:

- **`kg:shortterm` / `kg:overview` return more data.** Corpus request raised to `per_type_k: 85, recent_k: 550`
  (was 40/250), short-term to 400 entities + 80 docs. `kg:overview` is a **slow call** — measured 4s warm,
  ~15s cold against Echo, and it will be slower at the new density. It's on the panel's own load path, not
  yours, but if you're profiling boot don't be surprised by it.
- **A `hear`/`say` tap in `lib/db.js` `insertTurn`.** Emits a kg-activity event on user turns and `ai_said`
  turns. `ai_thought` is deliberately **not** tapped (the inner voice already arrives via `insertMonologue`).
  Content is sliced to 110 chars and goes only to the graph panel — it never re-enters a prompt.
- **`kg:self`** (new handler + `preload.js` `sq.kg.self`) reads `self_model` rows so the panel can draw her
  personality. Read-only, bounded to 96 rows.

---

## 3. Where slice 1 lands in my lane — and what I'd ask for

### A. Conversation objects + promotion — *the one I actually need*

This is the slice I care most about, because **the graph currently cannot draw a conversation at all.** The
panel's whole model is objects and edges; conversations exist only as the `hear`/`say` pulses above, which
are ephemeral gestures with no node behind them. The moment a conversation becomes a real object with an id,
I can:

- draw it as a node in the short-term region (it already renders `document`-kind nodes the same way),
- show a turn *linking* to the entities it mentioned — that's the "she connected this talk to what she knows"
  picture Lucas keeps asking for,
- and let it be clicked, so "that talk last Tuesday" is a thing on screen and not just a query.

**All I need is one line at the write site.** When a conversation object is created or promoted:

```js
require('./kg_activity').emit({ db: 'sidequest', kind: 'node.born', anchor: <conversation title or id> });
```

`lib/kg_activity.js` is a safe surface: it no-ops when nothing is listening, never throws, and takes no
dependency on the panel being open. If the object also gets edges to mentioned entities, `kind: 'edge.born'`
with `anchor` + `anchor2` draws the link being made. **Don't build anything for me** — just tell me the table
and the id column and I'll do the read side myself.

### B. Developing-story engage

`news` is already a kind in my activity log's colour table and **has no emitter anywhere in the repo** — it's
the one dead entry. If your story-following work has a natural "a followed story moved" moment, the same
one-liner with `kind: 'news'` lights it up. Entirely optional; I'd rather have A.

### C. Readings citable (#6)

`doc.land` is already tapped (`lib/db.js` `insertDocument`), so documents landing already pulse the graph. If
readings get a `docRef` to a stored doc, they inherit that for free — no action needed from you.

---

## 4. What I need that only your lane can give

Two write paths carry the substrate the graph is built on, and both live in files you own. **The graph is
blind to them today.** I have not touched either:

| Write site | What the graph is missing | Suggested kind |
|---|---|---|
| `lib/encounters.js` `record()` (~:121-147) | **the highest-value miss.** Every encounter — the thing the whole object model derives from. Fires constantly during a decompose sweep, so it **must be throttled** at the emit site the way `insertMonologue` is (`lib/db.js` `_lastThinkEmit`, ≥3.5s), or it will strobe the panel. Gate on `info.changes` so re-records don't double-count. | `encounter` |
| `lib/known_incorrect.js` `record()` (~:39-53) | a refutation landing. Sparse by design (508 rows against 102k encounters) so no throttle needed. | `refute` |

If you'd rather not touch them, say so and I'll take them through this doc — I only stayed out because
they're squarely yours.

---

## 5. Two traps worth carrying across your compact

**Colour space, if you ever touch a renderer.** This cost me most of a day and it's counter-intuitive:
three.js `ColorManagement` is on by default since r152, so `new THREE.Color()` produces **linear** values. A
hand-written `ShaderMaterial` gets **no** sRGB encode (three only appends it inside its own ShaderLib), while
a `color` BufferAttribute gets one **automatically**. Writing sRGB into one and linear into the other
produces exactly "everything too dark *and* a few things blindingly bright." Custom shaders need
`#include <colorspace_fragment>`; attributes need `Color.setRGB(r, g, b, THREE.SRGBColorSpace)`.

**Never smoke against the live `data/sq.db`.** Copy it and point `SQ_DB_PATH` at the copy. `db.getDb()`
*throws* until `db.init()` runs, and a blanket `try/catch` around it renders as "the data is all empty",
which is plausible enough to send you chasing a phantom.

---

## 6. Status of my lane, in one line

The surface is rendering well (evidence encoding, depth, glow, recognition halos, a click inspector, a live
activity dock). **The open item is the shape** — Lucas has rejected the brain arrangement twice, and my own
note in memory says the next attempt should not be another round of constant-tuning. That's mine to solve and
it doesn't touch you.

— graph-surface lane
