# wanderer_nullsec

Nullsec regional intel plugin for the [Wanderer](https://github.com/wanderer-industries/wanderer) EVE Online mapper.

When a wormhole chain connects to nullsec, this plugin gives instant visibility into all nullsec systems within 8 light-years of the entry point — without needing a separate desktop intel tool.

## What it shows

| Column | Source | Notes |
|--------|--------|-------|
| System | SDE | System name |
| LY | SDE 3D coordinates | Euclidean distance from entry |
| Gates | eve-route-builder | Stargate jump count (expandable route) |
| Sov | ESI /sovereignty/map/ | Alliance ticker |
| NPC Δ | ESI /universe/system_kills/ | Change in NPC kills (ratting proxy) |
| Mining Δ | ESI /industry/systems/ | Change in reaction cost index (mining proxy) |
| Jumps/hr | ESI /universe/system_jumps/ | Traffic volume |
| PvP | RedisQ | Ship kills in rolling 1hr window |
| ADM | ESI /sovereignty/structures/ | IHub occupancy level (0–6) |

## Requirements

- Wanderer Community Edition (Elixir/Phoenix)
- eve-route-builder service already running (`docker run -p 2001:2001 dansylvest/eve-route-builder:latest`)
- Network access to `esi.evetech.net` and `zkillredisq.stream`

## Installation

### Step 1 — Add dependency

In Wanderer's `mix.exs`:
```elixir
{:wanderer_nullsec, github: "your-org/wanderer_nullsec", branch: "main"}
```

### Step 2 — Add to supervision tree

In Wanderer's `lib/wanderer_app/application.ex`, add after `WandererApp.PubSub`:
```elixir
WandererNullsec.Application
```

### Step 3 — Add API route

In Wanderer's `lib/wanderer_app_web/router.ex`:
```elixir
scope "/api/nullsec", WandererNullsecWeb do
  pipe_through :api
  get "/intel/:system_id", WandererNullsecWeb.IntelController, :index
end
```

### Step 4 — Configure

In Wanderer's `config/runtime.exs`:
```elixir
config :wanderer_nullsec,
  intel_radius_ly: 8.0,
  route_builder_url: System.get_env("ROUTE_BUILDER_URL", "http://eve-route-builder:2001"),
  pubsub_server: WandererApp.PubSub
```

### Step 5 — Generate SDE CSV

```bash
# See priv/sde/README.md for full instructions
# Quick version with Fuzzwork postgres SDE:
psql -d sde -c "\copy (SELECT s.\"solarSystemID\", ...) TO 'priv/sde/nullsec_systems.csv' CSV HEADER"
```

### Step 6 — Frontend

```javascript
// In Wanderer's assets/js/app.js:
import NullsecIntelHook from "./nullsec/hooks/nullsecHook";
let Hooks = { ...existingHooks, NullsecIntelPanel: NullsecIntelHook };
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  WandererNullsec.Application (Supervision Tree)      │
│                                                      │
│  Finch pool ──────────────────────────────────────  │
│                                                      │
│  SDE.Systems (ETS, ~5500 nullsec systems from CSV)  │
│  Store.SystemCache (ETS, raw ESI + kill snapshots)  │
│  Store.DeltaTracker (ETS, 6hr rolling deltas)       │
│                                                      │
│  Routes.RouteClient ──► eve-route-builder:2001       │
│                                                      │
│  Collectors.Supervisor                               │
│    ├── SystemKills  (poll 10min) ──► ESI            │
│    ├── SystemJumps  (poll 10min) ──► ESI            │
│    ├── Sovereignty  (poll 30min) ──► ESI            │
│    ├── SovStructures (poll 5min) ──► ESI            │
│    └── Industry     (poll 30min) ──► ESI            │
│                                                      │
│  Killboard.Consumer ──► zkillredisq.stream (RedisQ) │
│                                                      │
│  Store.Aggregator (merges all → IntelEntry structs) │
│  Publisher ──────────────► WandererApp.PubSub        │
└─────────────────────────────────────────────────────┘
```

## ESI endpoints polled

All public — no authentication required.

| Endpoint | Interval | Purpose |
|----------|----------|---------|
| /v2/universe/system_kills/ | 10 min | NPC/ship/pod kills per system |
| /v1/universe/system_jumps/ | 10 min | Traffic volume |
| /v1/sovereignty/map/ | 30 min | Alliance sovereignty |
| /v2/sovereignty/structures/ | 5 min | ADM values |
| /v1/industry/systems/ | 30 min | Mining activity proxy |

## Gap resolution notes

These questions were investigated before implementation. Summary:

| Question | Answer | Impact |
|----------|--------|--------|
| Does Wanderer's kills service (port 4004) publish globally? | **No** — map-scoped only | Plugin runs own RedisQ consumer |
| eve-route-builder API schema? | Flat array `[sys_id, ...]` (old ESI format) | RouteClient handles both flat array and object response |
| Does Wanderer store SDE x/y/z? | **No** — wormhole mapper doesn't need them | Plugin bundles CSV from SDE |
| Does Wanderer poll system_kills/jumps/sov/industry? | **No** — uses kills service for kill data only | All collectors fully independent |
| SDE coordinate units? | **Metres** — divide by 9.4607×10¹⁵ for LY | Correct distance calculation confirmed |
| Kills service scope? | **Map-tracked systems only** | Plugin cannot tap into it |

## Developer: confirm eve-route-builder endpoint

One item needs a live service test (the repo is private):

```bash
docker run -p 2001:2001 dansylvest/eve-route-builder:latest

# Test which path format works:
curl http://localhost:2001/30000142/30002187/
curl "http://localhost:2001/route?origin=30000142&destination=30002187"
```

Then update `@path_style_template` in `lib/wanderer_nullsec/routes/route_client.ex`.
The implementation already handles both flat array and object responses.

## Configuration reference

| Key | Default | Description |
|-----|---------|-------------|
| `intel_radius_ly` | `8.0` | Neighbourhood radius in light-years |
| `esi_base_url` | `https://esi.evetech.net` | ESI base URL |
| `route_builder_url` | `http://eve-route-builder:2001` | Route service URL |
| `redisq_url` | `https://zkillredisq.stream/listen.php` | RedisQ URL |
| `route_cache_ttl_ms` | `86400000` (24h) | Route cache TTL |
| `delta_window_ms` | `21600000` (6h) | Activity delta window |
| `esi_poll_interval_ms` | `600000` (10min) | Fast collector interval |
| `sov_poll_interval_ms` | `1800000` (30min) | Slow collector interval |
| `pubsub_server` | `WandererApp.PubSub` | PubSub server atom |
