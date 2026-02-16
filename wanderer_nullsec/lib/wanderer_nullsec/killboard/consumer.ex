defmodule WandererNullsec.Killboard.Consumer do
  @moduledoc """
  Polls zKillboard RedisQ for real-time killmails.
  Filters to nullsec systems within the plugin's watch set.

  ## Why not Wanderer's kills service?

  Wanderer's kills service (wanderer-industries/wanderer-kills, port 4004)
  is MAP-SCOPED — it tracks only systems visible on an active Wanderer map
  session. The plugin watches arbitrary nullsec systems near a wormhole entry
  point, which will not be on any active map. The kills service cannot be used.

  ## RedisQ (as of 2025)

  URL migrated May 2025: zkillboard.com/listen.php → zkillredisq.stream/listen.php
  August 2025: /listen.php now redirects to /object.php?objectID=<id>.
  Req follows redirects automatically via `redirect: true`.

  Planned schema change (timing TBD): the full `killmail` object will be
  removed from the response, leaving only `killID` + `zkb` metadata.
  Both schemas are handled — see `build_kill_entry/1`.

  ## Queue IDs

  Each client must use a unique queueID. Multiple consumers on the same queue
  will each get a fraction of kills (Redis LPOP semantics). Use a node-stable
  unique ID in production.
  """

  use GenServer

  require Logger

  alias WandererNullsec.Store.{SystemCache, Aggregator}

  @redisq_base "https://zkillredisq.stream/listen.php"
  # Node-stable queue ID using node name hash — unique per deployment
  @queue_id "wanderer_nullsec_#{:erlang.phash2(node())}"
  @redisq_timeout_ms 12_000   # 10s server-side wait + 2s margin
  @repoll_delay_ms 100        # near-immediate re-poll after response

  # ---------------------------------------------------------------------------
  # Public API
  # ---------------------------------------------------------------------------

  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  # ---------------------------------------------------------------------------
  # GenServer callbacks
  # ---------------------------------------------------------------------------

  @impl true
  def init(_opts) do
    Logger.info("WandererNullsec.Killboard.Consumer starting, queueID: #{@queue_id}")
    schedule_poll(0)
    {:ok, %{queue_id: @queue_id, error_count: 0}}
  end

  @impl true
  def handle_info(:poll, state) do
    url = "#{@redisq_base}?queueID=#{state.queue_id}"

    {new_state, delay} =
      case Req.get(url, receive_timeout: @redisq_timeout_ms, redirect: true) do
        {:ok, %{status: 200, body: %{"package" => nil}}} ->
          # No kills in last 10s — normal operation
          {%{state | error_count: 0}, @repoll_delay_ms}

        {:ok, %{status: 200, body: %{"package" => package}}} when not is_nil(package) ->
          process_kill_package(package)
          {%{state | error_count: 0}, @repoll_delay_ms}

        {:ok, %{status: 429}} ->
          # One concurrent connection per queueID enforced by RedisQ
          Logger.warning("WandererNullsec.Killboard: RedisQ 429 — too many connections on queueID #{state.queue_id}")
          {%{state | error_count: state.error_count + 1}, 30_000}

        {:error, reason} ->
          new_count = state.error_count + 1
          backoff = min(1_000 * Integer.pow(2, min(new_count, 6)), 60_000)
          Logger.warning("WandererNullsec.Killboard: error #{inspect(reason)} (#{new_count}, retry in #{backoff}ms)")
          {%{state | error_count: new_count}, backoff}

        {:ok, %{status: status}} ->
          Logger.warning("WandererNullsec.Killboard: unexpected status #{status}")
          {%{state | error_count: state.error_count + 1}, 5_000}
      end

    schedule_poll(delay)
    {:noreply, new_state}
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  defp process_kill_package(package) do
    system_id = get_system_id(package)

    if system_id && nullsec_system?(system_id) do
      kill_entry = build_kill_entry(package)
      SystemCache.push_pvp_kill(system_id, kill_entry)
      GenServer.cast(WandererNullsec.Store.Aggregator, {:kill_event, system_id})
    end
  end

  # Current schema: full killmail included
  defp get_system_id(%{"killmail" => %{"solar_system_id" => id}}) when is_integer(id), do: id
  # Future schema: killmail removed, zkb metadata only
  defp get_system_id(%{"zkb" => %{"locationID" => id}}) when is_integer(id), do: id
  defp get_system_id(_), do: nil

  defp nullsec_system?(system_id) do
    case WandererNullsec.SDE.Systems.get(system_id) do
      %{security: sec} when sec < 0.0 and sec > -1.0 -> true
      _ -> false
    end
  end

  # Current schema — includes full killmail object
  defp build_kill_entry(%{"killID" => kill_id, "killmail" => km, "zkb" => zkb}) do
    %{
      kill_id:             kill_id,
      kill_time:           Map.get(km, "killmail_time"),
      victim_ship_type_id: get_in(km, ["victim", "ship_type_id"]),
      attacker_count:      length(Map.get(km, "attackers", [])),
      total_value:         Map.get(zkb, "totalValue", 0),
      npc:                 Map.get(zkb, "npc", false),
      solo:                Map.get(zkb, "solo", false),
      labels:              Map.get(zkb, "labels", []),
      recorded_at:         System.monotonic_time(:millisecond)
    }
  end

  # Future schema — killmail removed, zkb metadata only
  # Full detail available via ESI: GET /v1/killmails/{kill_id}/{hash}/
  defp build_kill_entry(%{"killID" => kill_id, "zkb" => zkb}) do
    %{
      kill_id:             kill_id,
      kill_time:           nil,
      victim_ship_type_id: nil,
      attacker_count:      nil,
      total_value:         Map.get(zkb, "totalValue", 0),
      npc:                 Map.get(zkb, "npc", false),
      solo:                Map.get(zkb, "solo", false),
      labels:              Map.get(zkb, "labels", []),
      hash:                Map.get(zkb, "hash"),
      esi_href:            Map.get(zkb, "href"),
      recorded_at:         System.monotonic_time(:millisecond)
    }
  end

  defp schedule_poll(delay), do: Process.send_after(self(), :poll, delay)
end
