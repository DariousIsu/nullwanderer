defmodule WandererNullsec.Collectors.Sovereignty do
  @moduledoc """
  Polls /v1/sovereignty/map/ every 30 minutes.
  Writes sovereignty data (alliance_id, faction_id) to SystemCache.

  ESI response schema:
    [{ "system_id": int, "alliance_id": int|null,
       "corporation_id": int|null, "faction_id": int|null }, ...]

  Sovereignty changes rarely — 30-minute interval is appropriate.
  ETag caching prevents unnecessary data transfer.
  """

  use GenServer

  require Logger

  alias WandererNullsec.ESI.Client
  alias WandererNullsec.Store.SystemCache
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
      case Client.get_sovereignty_map() do
        {:ok, :not_modified} ->
          %{state | error_count: 0}

        {:ok, data} when is_list(data) ->
          Enum.each(data, &process_system/1)
          %{state | error_count: 0}

        {:error, reason} ->
          new_count = state.error_count + 1
          Logger.warning("Sovereignty collector error #{new_count}/#{@error_budget}: #{inspect(reason)}")
          if new_count >= @error_budget do
            :telemetry.execute(
              [:wanderer_nullsec, :esi, :error_budget_exceeded],
              %{count: new_count},
              %{collector: :sovereignty}
            )
          end
          %{state | error_count: new_count}
      end

    schedule_poll(Config.sov_poll_interval_ms())
    {:noreply, new_state}
  end

  defp process_system(%{"system_id" => sys_id} = entry) do
    SystemCache.put({:sov, sys_id}, %{
      alliance_id:    Map.get(entry, "alliance_id"),
      corporation_id: Map.get(entry, "corporation_id"),
      faction_id:     Map.get(entry, "faction_id")
    })
  end
  defp process_system(_), do: :ok

  defp schedule_poll(delay), do: Process.send_after(self(), :poll, delay)
end
