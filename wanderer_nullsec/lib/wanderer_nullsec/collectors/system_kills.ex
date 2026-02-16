defmodule WandererNullsec.Collectors.SystemKills do
  @moduledoc """
  Polls /v2/universe/system_kills/ every 10 minutes.
  Writes raw kills to SystemCache and records deltas in DeltaTracker.

  ESI response schema:
    [{ "system_id": int, "npc_kills": int, "ship_kills": int, "pod_kills": int }, ...]

  Note: ESI caches this endpoint for ~1 hour on their end (hourly aggregate).
  ETag caching prevents redundant transfers when data hasn't changed.
  """

  use GenServer

  require Logger

  alias WandererNullsec.ESI.Client
  alias WandererNullsec.Store.{SystemCache, DeltaTracker}
  alias WandererNullsec.Config

  @error_budget 5  # halt if 5 consecutive failures

  def start_link(_opts), do: GenServer.start_link(__MODULE__, [], name: __MODULE__)

  @impl true
  def init(_) do
    schedule_poll(0)
    {:ok, %{error_count: 0}}
  end

  @impl true
  def handle_info(:poll, state) do
    new_state =
      case Client.get_system_kills() do
        {:ok, :not_modified} ->
          %{state | error_count: 0}

        {:ok, data} when is_list(data) ->
          Enum.each(data, &process_system/1)
          %{state | error_count: 0}

        {:error, {:rate_limited, wait_ms}} ->
          schedule_poll(wait_ms)
          %{state | error_count: state.error_count + 1}

        {:error, reason} ->
          new_count = state.error_count + 1
          Logger.warning("SystemKills collector error #{new_count}/#{@error_budget}: #{inspect(reason)}")
          if new_count >= @error_budget do
            :telemetry.execute(
              [:wanderer_nullsec, :esi, :error_budget_exceeded],
              %{count: new_count},
              %{collector: :system_kills}
            )
          end
          %{state | error_count: new_count}
      end

    schedule_poll(Config.esi_poll_interval_ms())
    {:noreply, new_state}
  end

  defp process_system(%{"system_id" => sys_id, "npc_kills" => npc,
                         "ship_kills" => ship, "pod_kills" => pod}) do
    SystemCache.put({:kills, sys_id}, %{npc: npc, ship: ship, pod: pod})
    DeltaTracker.record(:npc_kills,  sys_id, npc)
    DeltaTracker.record(:ship_kills, sys_id, ship)
    DeltaTracker.record(:pod_kills,  sys_id, pod)
  end
  defp process_system(_), do: :ok

  defp schedule_poll(delay), do: Process.send_after(self(), :poll, delay)
end
