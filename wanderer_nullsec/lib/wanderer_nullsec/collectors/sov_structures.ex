defmodule WandererNullsec.Collectors.SovStructures do
  @moduledoc """
  Polls /v2/sovereignty/structures/ every 5 minutes.
  Writes ADM (Infrastructure Hub vulnerability_occupancy_level) to SystemCache.

  ESI response schema:
    [{
      "solar_system_id": int,
      "alliance_id": int,
      "structure_id": int,
      "structure_type_id": int,           # 35832 = Infrastructure Hub (IHub)
      "vulnerability_occupancy_level": float|null,
      "vulnerable_start_time": string|null,
      "vulnerable_end_time": string|null
    }, ...]

  Only IHub structures (type_id 35832) carry the ADM value.
  One ADM per system — if multiple IHubs exist, take the highest occupancy.
  """

  use GenServer

  require Logger

  alias WandererNullsec.ESI.Client
  alias WandererNullsec.Store.SystemCache
  alias WandererNullsec.Config

  # Infrastructure Hub type ID
  @ihub_type_id 35832
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
      case Client.get_sovereignty_structures() do
        {:ok, :not_modified} ->
          %{state | error_count: 0}

        {:ok, data} when is_list(data) ->
          data
          |> Enum.filter(fn s -> Map.get(s, "structure_type_id") == @ihub_type_id end)
          |> Enum.each(&process_structure/1)
          %{state | error_count: 0}

        {:error, reason} ->
          new_count = state.error_count + 1
          Logger.warning("SovStructures collector error #{new_count}/#{@error_budget}: #{inspect(reason)}")
          if new_count >= @error_budget do
            :telemetry.execute(
              [:wanderer_nullsec, :esi, :error_budget_exceeded],
              %{count: new_count},
              %{collector: :sov_structures}
            )
          end
          %{state | error_count: new_count}
      end

    schedule_poll(Config.adm_poll_interval_ms())
    {:noreply, new_state}
  end

  defp process_structure(%{"solar_system_id" => sys_id} = s) do
    SystemCache.put({:adm, sys_id}, %{
      adm:        Map.get(s, "vulnerability_occupancy_level"),
      vuln_start: Map.get(s, "vulnerable_start_time"),
      vuln_end:   Map.get(s, "vulnerable_end_time")
    })
  end
  defp process_structure(_), do: :ok

  defp schedule_poll(delay), do: Process.send_after(self(), :poll, delay)
end
