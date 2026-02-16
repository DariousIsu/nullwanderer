defmodule WandererNullsec.Types do
  @moduledoc "Shared types for the wanderer_nullsec plugin."
end

defmodule WandererNullsec.Types.SDESystem do
  @moduledoc """
  Static SDE data for a single nullsec solar system.
  Loaded once at startup from priv/sde/nullsec_systems.csv.
  Coordinates are in metres (raw SDE values, double precision).
  """

  @type t :: %__MODULE__{
    solar_system_id:    pos_integer(),
    name:               String.t(),
    security:           float(),
    region_id:          pos_integer(),
    region_name:        String.t(),
    constellation_id:   pos_integer(),
    constellation_name: String.t(),
    x:                  float(),
    y:                  float(),
    z:                  float()
  }

  defstruct [
    :solar_system_id,
    :name,
    :security,
    :region_id,
    :region_name,
    :constellation_id,
    :constellation_name,
    :x,
    :y,
    :z
  ]
end

defmodule WandererNullsec.Types.IntelEntry do
  @moduledoc """
  Aggregated intel for a single nullsec system relative to a wormhole entry.
  Produced by Store.Aggregator; broadcast by Publisher.
  """

  @type t :: %__MODULE__{
    solar_system_id:                pos_integer(),
    name:                           String.t(),
    region_name:                    String.t(),
    constellation_name:             String.t() | nil,
    security:                       float(),
    distance_ly:                    float(),
    gate_jumps:                     non_neg_integer() | :no_route | nil,
    gate_route:                     [pos_integer()] | nil,
    sov_alliance_id:                pos_integer() | nil,
    sov_alliance_ticker:            String.t() | nil,
    sov_faction_id:                 pos_integer() | nil,
    adm_value:                      float() | nil,
    vulnerability_occupancy_level:  float() | nil,
    npc_kills:                      non_neg_integer(),
    npc_kills_delta:                integer(),
    ship_kills:                     non_neg_integer(),
    ship_kills_delta:               integer(),
    pod_kills:                      non_neg_integer(),
    pod_kills_delta:                integer(),
    jumps_per_hour:                 non_neg_integer(),
    jumps_delta:                    integer(),
    mining_cost_index:              float() | nil,
    mining_cost_delta:              float() | nil,
    pvp_kills_1hr:                  [map()],
    pvp_ship_count_1hr:             non_neg_integer(),
    last_updated:                   DateTime.t()
  }

  defstruct [
    :solar_system_id,
    :name,
    :region_name,
    :constellation_name,
    :security,
    :distance_ly,
    :gate_jumps,
    :gate_route,
    :sov_alliance_id,
    :sov_alliance_ticker,
    :sov_faction_id,
    :adm_value,
    :vulnerability_occupancy_level,
    npc_kills:           0,
    npc_kills_delta:     0,
    ship_kills:          0,
    ship_kills_delta:    0,
    pod_kills:           0,
    pod_kills_delta:     0,
    jumps_per_hour:      0,
    jumps_delta:         0,
    mining_cost_index:   nil,
    mining_cost_delta:   nil,
    pvp_kills_1hr:       [],
    pvp_ship_count_1hr:  0,
    :last_updated
  ]
end
