defmodule WandererNullsec.Collectors.SystemJumps do
  @moduledoc """
  Polls /v1/universe/system_jumps/ every 10 minutes.
  Writes raw jump counts to SystemCache and records deltas in DeltaTracker.

  ESI response schema:
    [{ "system_id": int, "ship_jumps": int }, ...]

  Note: ESI caches this endpoint at hourly granularity.
  """

  use GenServer

  require Logger

  alias WandererNullsec.ESI.Client
  alias WandererNullsec.Store.{SystemCache, DeltaTracker}
  alias WandererNullsec.Config

  @error_budget 5

  def start_link(_opts), do: GenServer.start_link(__MODULE__, [], name: __MODULE__)

  @impl true
  def init(_) do
    schedule_poll(0)
    {:ok, %{error_count: 0}}
  end

  @impl true
  def handle_info(:poll, state) do
    new_state =
      case Client.get_system_jumps() do
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
          Logger.warning("SystemJumps collector error #{new_count}/#{@error_budget}: #{inspect(reason)}")
          if new_count >= @error_budget do
            :telemetry.execute(
              [:wanderer_nullsec, :esi, :error_budget_exceeded],
              %{count: new_count},
              %{collector: :system_jumps}
            )
          end
          %{state | error_count: new_count}
      end

    schedule_poll(Config.esi_poll_interval_ms())
    {:noreply, new_state}
  end

  defp process_system(%{"system_id" => sys_id, "ship_jumps" => jumps}) do
    SystemCache.put({:jumps, sys_id}, %{jumps: jumps})
    DeltaTracker.record(:jumps, sys_id, jumps)
  end
  defp process_system(_), do: :ok

  defp schedule_poll(delay), do: Process.send_after(self(), :poll, delay)
end
