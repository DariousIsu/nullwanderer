defmodule WandererNullsec.Collectors.Industry do
  @moduledoc """
  Polls /v1/industry/systems/ every 30 minutes.
  Extracts the "reaction" cost index as a mining activity proxy.

  ESI response schema (per system):
    {
      "solar_system_id": int,
      "cost_indices": [
        { "activity": "manufacturing",              "cost_index": float },
        { "activity": "reaction",                   "cost_index": float },
        { "activity": "researching_time_efficiency","cost_index": float },
        { "activity": "researching_material_efficiency", "cost_index": float },
        { "activity": "copying",                    "cost_index": float },
        { "activity": "invention",                  "cost_index": float }
      ]
    }

  Mining proxy rationale: the "reaction" activity cost index correlates with
  moon-mining and ore compression activity better than "manufacturing", which
  is driven by station blueprint usage.
  """

  use GenServer

  require Logger

  alias WandererNullsec.ESI.Client
  alias WandererNullsec.Store.{SystemCache, DeltaTracker}
  alias WandererNullsec.Config

  @mining_activity "reaction"
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
      case Client.get_industry_systems() do
        {:ok, :not_modified} ->
          %{state | error_count: 0}

        {:ok, data} when is_list(data) ->
          Enum.each(data, &process_system/1)
          %{state | error_count: 0}

        {:error, reason} ->
          new_count = state.error_count + 1
          Logger.warning("Industry collector error #{new_count}/#{@error_budget}: #{inspect(reason)}")
          if new_count >= @error_budget do
            :telemetry.execute(
              [:wanderer_nullsec, :esi, :error_budget_exceeded],
              %{count: new_count},
              %{collector: :industry}
            )
          end
          %{state | error_count: new_count}
      end

    schedule_poll(Config.sov_poll_interval_ms())
    {:noreply, new_state}
  end

  defp process_system(%{"solar_system_id" => sys_id, "cost_indices" => indices}) do
    mining_index =
      Enum.find_value(indices, fn
        %{"activity" => @mining_activity, "cost_index" => v} -> v
        _ -> nil
      end)

    SystemCache.put({:industry, sys_id}, %{mining_cost_index: mining_index})

    if mining_index do
      DeltaTracker.record(:mining_cost, sys_id, mining_index)
    end
  end
  defp process_system(_), do: :ok

  defp schedule_poll(delay), do: Process.send_after(self(), :poll, delay)
end
