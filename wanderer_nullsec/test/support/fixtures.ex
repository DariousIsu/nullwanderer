defmodule WandererNullsec.Test.Fixtures do
  @moduledoc "Reusable test data factories."

  alias WandererNullsec.Types.{SDESystem, IntelEntry}

  @doc "A minimal nullsec SDESystem (Jita region coords for realism)."
  def sde_system(overrides \\ %{}) do
    Map.merge(%SDESystem{
      solar_system_id:    30000142,
      name:               "Jita",
      security:           -0.496,
      region_id:          10000002,
      region_name:        "The Forge",
      constellation_id:   20000020,
      constellation_name: "Kimotoro",
      x:                  1.9e17,
      y:                  -1.0e16,
      z:                  -3.8e16
    }, overrides)
  end

  @doc "A second system 3 LY from the default fixture."
  def nearby_sde_system(overrides \\ %{}) do
    Map.merge(%SDESystem{
      solar_system_id:    30000143,
      name:               "Maurasi",
      security:           -0.35,
      region_id:          10000002,
      region_name:        "The Forge",
      constellation_id:   20000020,
      constellation_name: "Kimotoro",
      x:                  1.9e17 + 2.838e16,
      y:                  -1.0e16,
      z:                  -3.8e16
    }, overrides)
  end

  def intel_entry(overrides \\ %{}) do
    Map.merge(%IntelEntry{
      solar_system_id:     30000142,
      name:                "Jita",
      region_name:         "The Forge",
      security:            -0.496,
      distance_ly:         1.5,
      gate_jumps:          3,
      gate_route:          [30000142, 30000143, 30000144, 30000145],
      npc_kills:           42,
      npc_kills_delta:     10,
      jumps_per_hour:      120,
      pvp_kills_1hr:       [],
      pvp_ship_count_1hr:  0,
      last_updated:        DateTime.utc_now()
    }, overrides)
  end

  @doc "Raw ESI system_kills response entry."
  def esi_kills_entry(system_id \\ 30000142) do
    %{"system_id" => system_id, "npc_kills" => 25, "ship_kills" => 3, "pod_kills" => 1}
  end

  @doc "Raw ESI system_jumps response entry."
  def esi_jumps_entry(system_id \\ 30000142) do
    %{"system_id" => system_id, "ship_jumps" => 47}
  end

  @doc "Raw ESI sovereignty/map entry."
  def esi_sov_entry(system_id \\ 30000142) do
    %{"system_id" => system_id, "alliance_id" => 99005338,
      "corporation_id" => nil, "faction_id" => nil}
  end

  @doc "Raw ESI sovereignty/structures IHub entry."
  def esi_ihub_entry(system_id \\ 30000142) do
    %{
      "solar_system_id"              => system_id,
      "alliance_id"                  => 99005338,
      "structure_id"                 => 1_021_122,
      "structure_type_id"            => 35832,
      "vulnerability_occupancy_level" => 4.8,
      "vulnerable_start_time"        => "2026-02-16T05:30:00Z",
      "vulnerable_end_time"          => "2026-02-16T07:30:00Z"
    }
  end

  @doc "Raw ESI industry/systems entry."
  def esi_industry_entry(system_id \\ 30000142) do
    %{
      "solar_system_id" => system_id,
      "cost_indices" => [
        %{"activity" => "manufacturing",                    "cost_index" => 0.023},
        %{"activity" => "reaction",                         "cost_index" => 0.041},
        %{"activity" => "researching_time_efficiency",      "cost_index" => 0.012},
        %{"activity" => "researching_material_efficiency",  "cost_index" => 0.011},
        %{"activity" => "copying",                          "cost_index" => 0.009},
        %{"activity" => "invention",                        "cost_index" => 0.018}
      ]
    }
  end

  @doc "Minimal CSV row for SDE systems loader."
  def csv_row(system_id \\ 30000142, name \\ "Jita") do
    %{
      "solarSystemID"    => to_string(system_id),
      "solarSystemName"  => name,
      "security"         => "-0.496",
      "regionID"         => "10000002",
      "regionName"       => "The Forge",
      "constellationID"  => "20000020",
      "constellationName" => "Kimotoro",
      "x"                => "1.9e+17",
      "y"                => "-1.0e+16",
      "z"                => "-3.8e+16"
    }
  end
end
