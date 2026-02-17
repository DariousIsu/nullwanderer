defmodule WandererNullsec.ESI.Client do
  @moduledoc """
  Tesla-based ESI HTTP client.

  Features:
    - ETag caching: conditional GET via If-None-Match header.
      ETags stored in the :nullsec_etags ETS table (owned by this GenServer).
    - Automatic retry: 3 retries with exponential backoff on 5xx/429.
    - Finch adapter: matches Wanderer's own HTTP connection pool.

  The ETS table :nullsec_etags is created by this GenServer's init/1 so it
  must be started before any collector calls these functions.
  """

  use GenServer

  require Logger

  @etag_table :nullsec_etags

  # ---------------------------------------------------------------------------
  # GenServer lifecycle — manages the ETag ETS table
  # ---------------------------------------------------------------------------

  def start_link(_opts), do: GenServer.start_link(__MODULE__, [], name: __MODULE__)

  @impl true
  def init(_) do
    :ets.new(@etag_table, [:named_table, :set, :public, read_concurrency: true])
    {:ok, %{}}
  end

  # ---------------------------------------------------------------------------
  # Public functions — called directly (no GenServer cast needed)
  # ---------------------------------------------------------------------------

  @doc "GET /v2/universe/system_kills/ — NPC/ship/pod kills per system."
  def get_system_kills, do: get("/v2/universe/system_kills/", :system_kills)

  @doc "GET /v1/universe/system_jumps/ — Ship jump count per system."
  def get_system_jumps, do: get("/v1/universe/system_jumps/", :system_jumps)

  @doc "GET /v1/sovereignty/map/ — Alliance/faction sov per system."
  def get_sovereignty_map, do: get("/v1/sovereignty/map/", :sov_map)

  @doc "GET /v2/sovereignty/structures/ — ADM values, vulnerability windows."
  def get_sovereignty_structures, do: get("/v2/sovereignty/structures/", :sov_structures)

  @doc "GET /v1/industry/systems/ — Cost indices including mining proxy."
  def get_industry_systems, do: get("/v1/industry/systems/", :industry_systems)

  # ---------------------------------------------------------------------------
  # Private HTTP helpers
  # ---------------------------------------------------------------------------

  defp get(path, etag_key) do
    base_url = WandererNullsec.Config.esi_base_url()
    url = base_url <> path
    headers = etag_headers(etag_key)

    opts = [
      receive_timeout: 15_000,
      headers: headers,
      retry: :transient,
      retry_delay: fn attempt -> trunc(1_000 * :math.pow(2, attempt)) end,
      max_retries: 3
    ]

    case Req.get(url, opts) do
      {:ok, %{status: 304}} ->
        {:ok, :not_modified}

      {:ok, %{status: 200, headers: resp_headers, body: body}} ->
        store_etag(etag_key, resp_headers)
        {:ok, body}

      {:ok, %{status: 429, headers: resp_headers}} ->
        wait = parse_retry_after(resp_headers)
        {:error, {:rate_limited, wait}}

      {:ok, %{status: status}} ->
        {:error, {:http_error, status}}

      {:error, reason} ->
        Logger.warning("ESI request failed for #{path}: #{inspect(reason)}")
        {:error, reason}
    end
  end

  defp etag_headers(key) do
    case :ets.lookup(@etag_table, key) do
      [{^key, etag}] -> [{"if-none-match", etag}]
      [] -> []
    end
  end

  defp store_etag(key, headers) when is_list(headers) do
    case List.keyfind(headers, "etag", 0) do
      {_, etag} -> :ets.insert(@etag_table, {key, etag})
      nil -> :ok
    end
  end
  defp store_etag(key, headers) when is_map(headers) do
    case Map.get(headers, "etag") do
      nil -> :ok
      etag -> :ets.insert(@etag_table, {key, etag})
    end
  end
  defp store_etag(_key, _headers), do: :ok

  defp parse_retry_after(headers) when is_list(headers) do
    case List.keyfind(headers, "retry-after", 0) do
      {_, v} -> String.to_integer(v) * 1_000
      nil -> 60_000
    end
  end
  defp parse_retry_after(headers) when is_map(headers) do
    case Map.get(headers, "retry-after") do
      nil -> 60_000
      v -> String.to_integer(v) * 1_000
    end
  end
  defp parse_retry_after(_), do: 60_000
end
