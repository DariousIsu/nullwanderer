defmodule WandererNullsec.Store.SystemCache do
  @moduledoc """
  ETS owner for raw ESI snapshots and killboard data.

  Key format: {type_atom, system_id}

  Types stored:
    {:kills,    system_id} → %{npc: int, ship: int, pod: int}
    {:jumps,    system_id} → %{jumps: int}
    {:sov,      system_id} → %{alliance_id: int|nil, faction_id: int|nil, corporation_id: int|nil}
    {:adm,      system_id} → %{adm: float|nil, vuln_start: string|nil, vuln_end: string|nil}
    {:industry, system_id} → %{mining_cost_index: float|nil, ...}
    {:pvp,      system_id} → [kill_map, ...]  — rolling 1hr window

  All values include a monotonic timestamp for staleness checks.
  """

  use GenServer

  @table :nullsec_system_cache
  @pvp_window_ms :timer.hours(1)
  @max_pvp_kills 500  # safety cap per system per hour

  # ---------------------------------------------------------------------------
  # Public API
  # ---------------------------------------------------------------------------

  def start_link(_), do: GenServer.start_link(__MODULE__, [], name: __MODULE__)

  @doc "Store a raw snapshot. Overwrites any existing value for this key."
  def put(key, value) do
    ts = System.monotonic_time(:millisecond)
    :ets.insert(@table, {key, value, ts})
    :ok
  end

  @doc "Retrieve a stored value. Returns {:ok, value} or {:error, :not_found}."
  def get(key) do
    case :ets.lookup(@table, key) do
      [{^key, value, _ts}] -> {:ok, value}
      [] -> {:error, :not_found}
    end
  end

  @doc "Get all entries matching a type prefix."
  def get_all_by_type(type) do
    :ets.match_object(@table, {{type, :_}, :_, :_})
    |> Enum.map(fn {{_type, id}, val, _ts} -> {id, val} end)
  end

  @doc """
  Append a kill to the rolling 1-hour PvP window for a system.
  Each kill_entry must have a `:recorded_at` field (monotonic ms timestamp).
  Prunes kills older than 1 hour automatically.
  """
  def push_pvp_kill(system_id, kill_entry) do
    key = {:pvp, system_id}
    now = System.monotonic_time(:millisecond)

    existing =
      case :ets.lookup(@table, key) do
        [{^key, kills, _ts}] -> kills
        [] -> []
      end

    pruned =
      Enum.filter(existing, fn k ->
        now - k.recorded_at < @pvp_window_ms
      end)

    updated = [kill_entry | pruned] |> Enum.take(@max_pvp_kills)
    :ets.insert(@table, {key, updated, now})
    :ok
  end

  @doc "Get PvP kills for a system in the rolling 1-hour window."
  def get_pvp_kills(system_id) do
    case :ets.lookup(@table, {:pvp, system_id}) do
      [{_, kills, _}] -> kills
      [] -> []
    end
  end

  # ---------------------------------------------------------------------------
  # GenServer callbacks
  # ---------------------------------------------------------------------------

  @impl true
  def init(_) do
    :ets.new(@table, [
      :named_table,
      :set,
      :public,
      write_concurrency: true,
      read_concurrency: true
    ])
    {:ok, %{}}
  end
end
