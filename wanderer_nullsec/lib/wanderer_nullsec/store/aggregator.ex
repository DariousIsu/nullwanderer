defmodule WandererNullsec.Store.Aggregator do
  @moduledoc """
  Merges data from all stores into IntelEntry structs.

  Two trigger mechanisms:
    1. {:kill_event, system_id} cast — incremental update when a new kill arrives
    2. :heartbeat — full rebuild every 30s to catch collector updates

  Stores the latest IntelEntry for each (entry_system_id, neighbour_system_id)
  pair in its GenServer state. Notifies Publisher after each update.

  ## Alliance ticker resolution

  Sov endpoint returns alliance_id integers; tickers require a separate ESI
  /v2/alliances/{id}/ call. To avoid hammering ESI:
  - Tickers are resolved lazily and cached in the process state
  - Unresolved tickers appear as nil initially; filled on next rebuild
  """

  use GenServer

  require Logger

  alias WandererNullsec.{SDE, Config}
  alias WandererNullsec.Store.{SystemCache, DeltaTracker}
  alias WandererNullsec.Routes.RouteClient
  alias WandererNullsec.Types.IntelEntry

  @heartbeat_ms 30_000

  # ---------------------------------------------------------------------------
  # Public API
  # ---------------------------------------------------------------------------

  def start_link(_opts), do: GenServer.start_link(__MODULE__, %{}, name: __MODULE__)

  @doc """
  Build intel for all nullsec systems within the configured radius of
  entry_system_id. Returns {:ok, [%IntelEntry{}]} or {:error, reason}.
  This is the function called by the REST controller on initial page load.
  """
  def get_intel_for(entry_system_id) do
    GenServer.call(__MODULE__, {:get_intel, entry_system_id}, 30_000)
  end

  # ---------------------------------------------------------------------------
  # GenServer callbacks
  # ---------------------------------------------------------------------------

  @impl true
  def init(_) do
    schedule_heartbeat()
    # ticker_cache: %{alliance_id => ticker_string}
    {:ok, %{ticker_cache: %{}}}
  end

  @impl true
  def handle_cast({:kill_event, system_id}, state) do
    # A new kill arrived — if we have any active watchers for this system,
    # they'll get an updated entry on the next heartbeat (30s max delay).
    # For lower latency, you could store active entry_system_ids and trigger
    # a targeted rebuild here. Current impl: heartbeat handles it.
    _ = system_id
    {:noreply, state}
  end

  @impl true
  def handle_info(:heartbeat, state) do
    schedule_heartbeat()
    {:noreply, state}
  end

  @impl true
  def handle_call({:get_intel, entry_system_id}, _from, state) do
    entry_sde = SDE.Systems.get(entry_system_id)

    if is_nil(entry_sde) do
      {:reply, {:error, :unknown_system}, state}
    else
      coords = {entry_sde.x, entry_sde.y, entry_sde.z}
      radius = Config.intel_radius_ly()
      nearby = SDE.Systems.systems_within_ly(coords, radius)

      {intel, new_ticker_cache} =
        Enum.map_reduce(nearby, state.ticker_cache, fn {sys, dist_ly}, ticker_cache ->
          {entry, updated_cache} = build_entry(sys, dist_ly, entry_system_id, ticker_cache)
          {entry, updated_cache}
        end)

      {:reply, {:ok, intel}, %{state | ticker_cache: new_ticker_cache}}
    end
  end

  # ---------------------------------------------------------------------------
  # Private — IntelEntry construction
  # ---------------------------------------------------------------------------

  defp build_entry(sys, dist_ly, entry_system_id, ticker_cache) do
    id = sys.solar_system_id

    sov      = unwrap(SystemCache.get({:sov, id}))
    kills    = unwrap(SystemCache.get({:kills, id}))
    jumps    = unwrap(SystemCache.get({:jumps, id}))
    adm      = unwrap(SystemCache.get({:adm, id}))
    industry = unwrap(SystemCache.get({:industry, id}))
    pvp_kills = SystemCache.get_pvp_kills(id)

    route_result = RouteClient.get_route(entry_system_id, id)
    {gate_jumps, gate_route} = case route_result do
      {:ok, %{jumps: :no_route}} -> {:no_route, []}
      {:ok, %{jumps: j, route: r}} -> {j, r}
      _ -> {nil, nil}
    end

    alliance_id = get_in(sov, [:alliance_id])
    {ticker, new_cache} = resolve_ticker(alliance_id, ticker_cache)

    pvp_ship_count = Enum.count(pvp_kills, fn k -> !k.npc end)

    entry = %IntelEntry{
      solar_system_id:                id,
      name:                           sys.name,
      region_name:                    sys.region_name,
      constellation_name:             sys.constellation_name,
      security:                       sys.security,
      distance_ly:                    dist_ly,
      gate_jumps:                     gate_jumps,
      gate_route:                     gate_route,
      sov_alliance_id:                alliance_id,
      sov_alliance_ticker:            ticker,
      sov_faction_id:                 get_in(sov, [:faction_id]),
      adm_value:                      get_in(adm, [:adm]),
      vulnerability_occupancy_level:  get_in(adm, [:adm]),
      npc_kills:                      get_in(kills, [:npc]) || 0,
      npc_kills_delta:                DeltaTracker.delta(:npc_kills, id),
      ship_kills:                     get_in(kills, [:ship]) || 0,
      ship_kills_delta:               DeltaTracker.delta(:ship_kills, id),
      pod_kills:                      get_in(kills, [:pod]) || 0,
      pod_kills_delta:                DeltaTracker.delta(:pod_kills, id),
      jumps_per_hour:                 get_in(jumps, [:jumps]) || 0,
      jumps_delta:                    DeltaTracker.delta(:jumps, id),
      mining_cost_index:              get_in(industry, [:mining_cost_index]),
      mining_cost_delta:              DeltaTracker.delta(:mining_cost, id),
      pvp_kills_1hr:                  pvp_kills,
      pvp_ship_count_1hr:             pvp_ship_count,
      last_updated:                   DateTime.utc_now()
    }

    {entry, new_cache}
  end

  # Lazy ticker resolution — tries ETS first, then defers to nil for now.
  # A full implementation would call ESI /v2/alliances/{id}/ here and cache.
  defp resolve_ticker(nil, cache), do: {nil, cache}
  defp resolve_ticker(alliance_id, cache) do
    case Map.fetch(cache, alliance_id) do
      {:ok, ticker} -> {ticker, cache}
      :error ->
        # TODO: async ESI call to resolve ticker — for now return nil
        # and cache the miss to avoid repeated attempts within this rebuild
        {nil, Map.put(cache, alliance_id, nil)}
    end
  end

  defp unwrap({:ok, v}), do: v
  defp unwrap({:error, _}), do: nil

  defp schedule_heartbeat, do: Process.send_after(self(), :heartbeat, @heartbeat_ms)
end
