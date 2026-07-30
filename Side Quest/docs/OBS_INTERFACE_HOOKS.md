# OBS Interface Hooks — the visual autonomy log's connection contract

*2026-07-30. For the parallel lane building the visual log window. Backend: `lib/obs_bus.js`
(the bounded event store) + `lib/self_watch.js` (the internal log reader that feeds it).
Stay in lane: these two libs + the two IPC surfaces below are the whole contract — the UI
should need nothing else from main.*

## What this stream is

One structured, bounded event stream of the autonomous system observing itself:

- **her log lines as they stream** — every console line from the autonomy organs, classified
  at the source (a console hook in main; no file tailing);
- **her decisions about them** — anomaly classifications, "recurring failure → opened need #N"
  minting decisions, periodic counter digests;
- **testing and execution results** — rehearsal/sandbox lifecycle lines, analysis-lane runs,
  directed-run milestones (`started/completed/saturated/pass cap`), citation stamps.

## Event shape

```js
{
  id:    412,                 // monotonically increasing (poll cursor). ABSENT on live-push events.
  ts:    1785440000000,       // epoch ms
  lane:  'subc',              // see taxonomy below
  kind:  'line',              // 'line' | 'anomaly' | 'status' | 'need' | (future kinds — render generically)
  level: 'info',              // 'info' | 'warn' | 'error'
  text:  '[subc] synthesis stored — tension: "…" → action: research',   // ≤500 chars, whitespace-collapsed
  ref:   'thread:3632',       // machine handle or null: 'thread:N' | 'need:N'
  data:  { sig: '…', hits24h: 3 }   // small JSON extras or null (parsed on the poll path)
}
```

### Lane taxonomy (current writers)

| lane        | what flows there                                                          |
|-------------|---------------------------------------------------------------------------|
| `subc`      | subconscious synthesis: tensions, typed actions, spawns/deferrals, positions |
| `directed`  | the user-run driver: target started/completed, steering, news vigilance    |
| `research`  | citation stamps (`[cite]`), run-closure doors (`[closure]`)                |
| `window`    | prompt-fit reports (`[fit]`) and window-overrun warnings (`[window]`)      |
| `rehearsal` | sandbox lifecycle + test results                                           |
| `analysis`  | R3 read-only analysis runs                                                 |
| `doc-set`   | canvas document-set analysis lane                                          |
| `harvest`   | conversation-harvest materials                                             |
| `watch`     | the watcher's own decisions: `status` digests, `need` minting              |
| `anomaly`   | error-level lines from non-signal lanes                                    |

New lanes may appear as organs gain structured emits — render unknown lanes generically rather
than dropping them.

## Reading it

### 1. Live push (render as they happen)

Every event is broadcast to **all** webContents the moment it's emitted:

```js
const { ipcRenderer } = require('electron');
ipcRenderer.on('obs:event', (_e, evt) => appendToView(evt));   // evt has NO id — display only
```

### 2. Catch-up poll (history + reconnect + the id cursor)

```js
const r = await ipcRenderer.invoke('obs:recent', { sinceId: lastSeenId, limit: 200 });
// r = { ok: true, events: [...] }  — ascending id, each ≤500-char text, data already parsed
// filters: { lanes: ['subc','watch'], kinds: ['anomaly'] } both optional
```

Standard pattern: on window open, poll `sinceId: 0` (or persist your own cursor) to backfill,
then ride `obs:event` live; on any doubt, re-poll from your last id — ids are authoritative,
the live push is display-only convenience.

### 3. Out-of-process option

`data/sq.db` (WAL — concurrent external reads are safe and proven) table `obs_events`, same
columns as the shape above (`data` is a JSON string there). Poll `WHERE id > ?` exactly like
`recent()` does. Use this only if the UI lives outside the Electron renderer.

## Guarantees + limits

- **Bounded**: the store keeps ≤ 20,000 rows / 7 days (pruned on a write cadence). Don't build
  archival features on it; it's a live window, not a ledger.
- **Batched writes**: events land in the table within ~1.5s of the live push. A poll racing the
  flush can briefly miss what the push already showed — the id cursor heals this on next poll.
- **Volume-shaped**: noisy lanes (captions, feeds, …) are *counted*, not stored — they appear
  inside `watch`/`status` events' `data.counts`, one digest per ~5 min. Anomalies are capped at
  one stored row per signature per hour (repeats ride the digest counters).
- **The raw firehose stays in the boot log files** (`bootNNN.log` / `.err.log`, shell-redirected).
  If the UI ever wants unfiltered raw lines, tail those files; the bus carries the *signal*.

## Writing to it (for backend organs only — the UI never writes)

```js
require('./obs_bus').emit({ lane, kind, level, text, ref, data });   // fail-soft, never throws
```
