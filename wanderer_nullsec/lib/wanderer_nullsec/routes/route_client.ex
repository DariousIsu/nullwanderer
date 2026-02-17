defmodule WandererNullsec.Routes.RouteClient do
  @moduledoc """
  Calls eve-route-builder (port 2001, TypeScript) for stargate jump counts
  and full route paths. Caches results in ETS with a 24-hour TTL.

  ## eve-route-builder API

  The service (`dansylvest/eve-route-builder:latest`, private repo) mirrors
  the old deprecated ESI `/route/{origin}/{destination}/` endpoint. Based on
  the repo description ("same EVE API route") and the old ESI interface, the
  expected response is a **flat JSON array of system IDs**:

      GET http://eve-route-builder:2001/{origin}/{dest}/
      → [30000142, 30000143, 30002187]   (route including origin and dest)

  Jump count = length(route) - 1.

  ⚠ This needs confirmation with a live `docker run` test:

      docker run -p 2001:2001 dansylvest/eve-route-builder:latest
      curl http://localhost:2001/30000142/30002187/
      # or: curl "http://localhost:2001/route?origin=30000142&destination=30002187"

  The implementation handles both flat array and object-style responses
  defensively. Update @route_path_template once the actual endpoint is confirmed.

  ## Batching

  Route lookups are batched in chunks of @max_concurrent (10) to avoid
  overwhelming the route service when a new entry point is selected and
  many systems need routes calculated simultaneously.
  """

  use GenServer

  require Logger

  alias WandererNullsec.Config

  @table :nullsec_route_cache
  @max_concurrent 10

  # ⚠ UPDATE after confirming with `docker run` test
  # Options tried in order by fetch_and_cache/3:
  #   1. /{origin}/{dest}/          — mirrors old ESI path style (expected)
  #   2. /route?origin=...&dest=... — query param style (fallback)
  @path_style_template "/{origin}/{dest}/"
  @query_style_template "/route?origin={origin}&destination={dest}"

  # ---------------------------------------------------------------------------
  # Public API
  # ---------------------------------------------------------------------------

  def start_link(_opts), do: GenServer.start_link(__MODULE__, [], name: __MODULE__)

  @doc """
  Get the route from origin_id to dest_id.
  Returns {:ok, %{route: [system_id], jumps: integer | :no_route}} or {:error, reason}.
  Uses ETS cache; fetches from route service if stale or missing.
  """
  def get_route(origin_id, dest_id) do
    GenServer.call(__MODULE__, {:get_route, origin_id, dest_id}, 15_000)
  end

  @doc """
  Batch fetch routes for a list of {origin_id, dest_id} pairs.
  Processed in chunks of #{@max_concurrent} concurrent requests.
  Returns a map of {origin, dest} => {:ok, route_entry} | {:error, reason}.
  """
  def get_routes_batch(pairs) do
    pairs
    |> Enum.chunk_every(@max_concurrent)
    |> Enum.flat_map(fn chunk ->
      Task.async_stream(
        chunk,
        fn {o, d} -> {{o, d}, get_route(o, d)} end,
        max_concurrency: @max_concurrent,
        timeout: 15_000
      )
      |> Enum.map(fn {:ok, result} -> result end)
    end)
    |> Map.new()
  end

  # ---------------------------------------------------------------------------
  # GenServer callbacks
  # ---------------------------------------------------------------------------

  @impl true
  def init(_) do
    :ets.new(@table, [:named_table, :set, :public, read_concurrency: true])
    {:ok, %{base_url: Config.route_builder_url()}}
  end

  @impl true
  def handle_call({:get_route, origin, dest}, _from, state) do
    key = {origin, dest}
    ttl = Config.route_cache_ttl_ms()
    now = System.monotonic_time(:millisecond)

    result =
      case :ets.lookup(@table, key) do
        [{^key, entry, ts}] when now - ts < ttl ->
          {:ok, entry}

        _ ->
          fetch_and_cache(origin, dest, state.base_url)
      end

    {:reply, result, state}
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  defp fetch_and_cache(origin, dest, base_url) do
    # Try path-style first (expected based on old ESI interface)
    path = @path_style_template
           |> String.replace("{origin}", to_string(origin))
           |> String.replace("{dest}", to_string(dest))

    url = base_url <> path

    case Req.get(url, receive_timeout: 10_000) do
      {:ok, %{status: 200, body: route}} when is_list(route) ->
        # Flat array of system IDs — old ESI format
        cache_and_return({origin, dest}, route)

      {:ok, %{status: 200, body: %{"route" => route}}} when is_list(route) ->
        # Object-style fallback
        cache_and_return({origin, dest}, route)

      {:ok, %{status: s}} when s in [404, 400, 204] ->
        # No route exists (disconnected regions, same system, etc.)
        entry = %{route: [], jumps: :no_route}
        :ets.insert(@table, {{origin, dest}, entry, System.monotonic_time(:millisecond)})
        {:ok, entry}

      {:ok, %{status: status}} ->
        Logger.warning("RouteClient: HTTP #{status} for #{origin}→#{dest}, trying query-style")
        fetch_query_style(origin, dest, base_url)

      {:error, reason} ->
        Logger.warning("RouteClient: request failed for #{origin}→#{dest}: #{inspect(reason)}")
        {:error, {:route_service_error, reason}}
    end
  end

  defp fetch_query_style(origin, dest, base_url) do
    path = @query_style_template
           |> String.replace("{origin}", to_string(origin))
           |> String.replace("{dest}", to_string(dest))

    url = base_url <> path

    case Req.get(url, receive_timeout: 10_000) do
      {:ok, %{status: 200, body: route}} when is_list(route) ->
        cache_and_return({origin, dest}, route)

      {:ok, %{status: 200, body: %{"route" => route}}} when is_list(route) ->
        cache_and_return({origin, dest}, route)

      {:ok, %{status: s}} when s in [404, 400] ->
        {:ok, %{route: [], jumps: :no_route}}

      other ->
        {:error, {:route_service_error, other}}
    end
  end

  defp cache_and_return({origin, dest}, route) do
    jumps = max(0, length(route) - 1)
    entry = %{route: route, jumps: jumps}
    :ets.insert(@table, {{origin, dest}, entry, System.monotonic_time(:millisecond)})
    {:ok, entry}
  end
end
