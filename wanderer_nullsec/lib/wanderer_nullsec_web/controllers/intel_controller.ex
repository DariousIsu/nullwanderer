defmodule WandererNullsecWeb.IntelController do
  @moduledoc """
  REST controller for nullsec intel data.

  Route (add to Wanderer's router.ex):

      scope "/api/nullsec", WandererNullsecWeb do
        pipe_through :api
        get "/intel/:system_id", IntelController, :index
      end

  ## Endpoints

      GET /api/nullsec/intel/:system_id

  Returns all nullsec systems within the configured radius (default 8 LY)
  of the given entry system, with aggregated ESI activity data.

  The :system_id should be the EVE solar system ID of the nullsec entry
  point from the wormhole chain (e.g. 30000142 for Jita).

  ## Authentication

  Uses Wanderer's existing :api pipeline (Bearer map token).
  Add authentication plug if desired — currently inherits Wanderer's pipeline.
  """

  use Phoenix.Controller, formats: [:json]

  alias WandererNullsec.Store.Aggregator
  alias WandererNullsec.Types.IntelEntry

  # GET /api/nullsec/intel/:system_id
  def index(conn, %{"system_id" => system_id_str}) do
    with {system_id, ""} <- Integer.parse(system_id_str),
         {:ok, entries} <- Aggregator.get_intel_for(system_id) do
      conn
      |> put_status(200)
      |> json(%{
        data: Enum.map(entries, &serialize_entry/1),
        meta: %{
          entry_system_id: system_id,
          system_count: length(entries),
          radius_ly: WandererNullsec.Config.intel_radius_ly(),
          generated_at: DateTime.utc_now() |> DateTime.to_iso8601()
        }
      })
    else
      :error ->
        conn
        |> put_status(400)
        |> json(%{error: "Invalid system_id: must be an integer"})

      {:error, :unknown_system} ->
        conn
        |> put_status(404)
        |> json(%{error: "System not found in nullsec SDE. Only nullsec systems (security < 0.0) are supported."})

      {:error, reason} ->
        conn
        |> put_status(500)
        |> json(%{error: "Failed to build intel: #{inspect(reason)}"})
    end
  end

  # ---------------------------------------------------------------------------
  # Private — JSON serialisation
  # ---------------------------------------------------------------------------

  defp serialize_entry(%IntelEntry{} = e) do
    %{
      solar_system_id:                 e.solar_system_id,
      name:                            e.name,
      region_name:                     e.region_name,
      constellation_name:              e.constellation_name,
      security:                        e.security,
      distance_ly:                     e.distance_ly,
      gate_jumps:                      serialize_jumps(e.gate_jumps),
      gate_route:                      e.gate_route,
      sov_alliance_id:                 e.sov_alliance_id,
      sov_alliance_ticker:             e.sov_alliance_ticker,
      sov_faction_id:                  e.sov_faction_id,
      adm_value:                       e.adm_value,
      npc_kills:                       e.npc_kills,
      npc_kills_delta:                 e.npc_kills_delta,
      ship_kills:                      e.ship_kills,
      ship_kills_delta:                e.ship_kills_delta,
      pod_kills:                       e.pod_kills,
      pod_kills_delta:                 e.pod_kills_delta,
      jumps_per_hour:                  e.jumps_per_hour,
      jumps_delta:                     e.jumps_delta,
      mining_cost_index:               e.mining_cost_index,
      mining_cost_delta:               e.mining_cost_delta,
      pvp_ship_count_1hr:              e.pvp_ship_count_1hr,
      pvp_kills_1hr:                   Enum.map(e.pvp_kills_1hr || [], &serialize_kill/1),
      last_updated:                    DateTime.to_iso8601(e.last_updated)
    }
  end

  defp serialize_jumps(:no_route), do: nil
  defp serialize_jumps(n), do: n

  defp serialize_kill(k) do
    Map.take(k, [:kill_id, :kill_time, :victim_ship_type_id, :attacker_count,
                  :total_value, :npc, :solo])
  end
end
