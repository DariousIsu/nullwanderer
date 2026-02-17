defmodule WandererNullsec.Store.DeltaTracker do
  @moduledoc """
  ETS-backed rolling window of time-series snapshots for computing deltas.

  Stores up to @max_snapshots entries per (metric, system_id) key.
  Entries older than @window_ms are pruned on each new record() call.

  delta/2 returns current_value - oldest_value_in_window.
  Returns 0 when fewer than 2 data points exist.
  """

  use GenServer

  @table :nullsec_delta_tracker
  @max_snapshots 12  # 6 hours at 30-minute collector intervals

  # ---------------------------------------------------------------------------
  # Public API
  # ---------------------------------------------------------------------------

  def start_link(_), do: GenServer.start_link(__MODULE__, [], name: __MODULE__)

  @doc """
  Record a new snapshot value for (metric, system_id).
  Prunes entries older than delta_window_ms automatically.
  metric is an atom, e.g. :npc_kills, :jumps, :mining_cost.
  """
  @spec record(atom(), integer(), number()) :: :ok
  def record(metric, system_id, value) do
    now = System.monotonic_time(:millisecond)
    window = WandererNullsec.Config.delta_window_ms()
    key = {metric, system_id}

    history =
      case :ets.lookup(@table, key) do
        [{^key, h}] -> h
        [] -> []
      end

    pruned = Enum.filter(history, fn {ts, _} -> now - ts < window end)
    updated = [{now, value} | pruned] |> Enum.take(@max_snapshots)
    :ets.insert(@table, {key, updated})
    :ok
  end

  @doc """
  Compute delta: current_value - oldest_value_in_window.
  Returns 0 if fewer than 2 snapshots exist.
  """
  @spec delta(atom(), integer()) :: number()
  def delta(metric, system_id) do
    key = {metric, system_id}

    case :ets.lookup(@table, key) do
      [{^key, [{_, current} | rest]}] when rest != [] ->
        {_, oldest} = List.last(rest)
        current - oldest

      _ ->
        0
    end
  end

  @doc "Clear all history for testing."
  def clear do
    :ets.delete_all_objects(@table)
    :ok
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
