defmodule WandererNullsec.Application do
  @moduledoc """
  OTP Application entry point for the wanderer_nullsec plugin.

  Startup order is critical:

    Phase 0 — HTTP connection pool (Finch) must start before any HTTP clients.
    Phase 1 — Static data (SDE.Systems) and ETS stores must be ready before
              collectors begin writing to them.
    Phase 2 — RouteClient cache before aggregator needs route lookups.
    Phase 3 — ESI collectors (all independent, no Wanderer overlap confirmed).
    Phase 4 — Killboard.Consumer (RedisQ long-poll, not Wanderer's kills service
              which is map-scoped and cannot be used for arbitrary nullsec systems).
    Phase 5 — Aggregator + Publisher (read from all stores above).

  Integration into Wanderer:
    Add `WandererNullsec.Application` as a child in Wanderer's application.ex
    *after* `WandererApp.PubSub` starts. Or simply add {:wanderer_nullsec, ...}
    to mix.exs — the OTP app system starts it automatically.

    Set in Wanderer's config/runtime.exs:
      config :wanderer_nullsec,
        pubsub_server: WandererApp.PubSub,
        route_builder_url: System.get_env("ROUTE_BUILDER_URL", "http://eve-route-builder:2001")
  """

  use Application

  @impl true
  def start(_type, _args) do
    children = [
      # -----------------------------------------------------------------------
      # Phase 0: HTTP connection pool
      # Finch pools are sized conservatively — ESI rate limits are the real
      # bottleneck, not connection throughput.
      # -----------------------------------------------------------------------
      {Finch,
       name: WandererNullsec.Finch,
       pools: %{
         "https://esi.evetech.net" => [size: 4, count: 1],
         "http://eve-route-builder:2001" => [size: 4, count: 1],
         :default => [size: 2, count: 1]
       }},

      # -----------------------------------------------------------------------
      # Phase 0.5: ESI client — creates :nullsec_etags ETS table used by collectors
      # -----------------------------------------------------------------------
      WandererNullsec.ESI.Client,

      # -----------------------------------------------------------------------
      # Phase 1: Static data + ETS stores
      # SDE.Systems loads ~5,500 nullsec systems from bundled CSV at startup.
      # Wanderer's DB does NOT store x/y/z coordinates (confirmed — wormhole
      # mapper has no need for 3D positions). CSV is the only source.
      # -----------------------------------------------------------------------
      WandererNullsec.SDE.Systems,
      WandererNullsec.Store.SystemCache,
      WandererNullsec.Store.DeltaTracker,

      # -----------------------------------------------------------------------
      # Phase 2: Route cache
      # Calls eve-route-builder (port 2001) for stargate jump paths.
      # Caches with 24hr TTL — stargate topology changes rarely.
      # -----------------------------------------------------------------------
      WandererNullsec.Routes.RouteClient,

      # -----------------------------------------------------------------------
      # Phase 3: ESI collectors
      # All five are independent — confirmed Wanderer does NOT poll any of
      # these endpoints (it uses the kills service WebSocket for kill data,
      # and has no jump/sov/industry data displays).
      # -----------------------------------------------------------------------
      WandererNullsec.Collectors.Supervisor,

      # -----------------------------------------------------------------------
      # Phase 4: Killboard consumer
      # Uses RedisQ (https://zkillredisq.stream/) HTTP long-poll.
      # Wanderer's kills service (port 4004) is map-scoped and does NOT relay
      # kills for arbitrary nullsec systems — plugin must run its own consumer.
      # Note: /listen.php redirects to /object.php since Aug 2025; Req follows
      # redirects automatically.
      # -----------------------------------------------------------------------
      WandererNullsec.Killboard.Consumer,

      # -----------------------------------------------------------------------
      # Phase 5: Aggregator + Publisher
      # Aggregator reads from all stores above and builds IntelEntry structs.
      # Publisher broadcasts to WandererApp.PubSub (configured at runtime).
      # -----------------------------------------------------------------------
      WandererNullsec.Store.Aggregator,
      WandererNullsec.Publisher
    ]

    opts = [strategy: :one_for_one, name: WandererNullsec.Supervisor]
    Supervisor.start_link(children, opts)
  end
end
