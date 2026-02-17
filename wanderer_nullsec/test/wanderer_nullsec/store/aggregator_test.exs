defmodule WandererNullsec.Store.AggregatorTest do
  use ExUnit.Case, async: false

  alias WandererNullsec.Store.{Aggregator, SystemCache, DeltaTracker}
  alias WandererNullsec.Types.SDESystem

  setup do
    start_supervised!(SystemCache)
    start_supervised!(DeltaTracker)

    try do
      :ets.new(:nullsec_sde_systems, [:named_table, :set, :public, read_concurrency: true])
    rescue
      ArgumentError -> :ok
    end

    sys = %SDESystem{
      solar_system_id: 30000142, name: "Jita", security: -0.496,
      region_id: 10000002, region_name: "The Forge",
      constellation_id: 20000020, constellation_name: "Kimotoro",
      x: 1.9e17, y: -1.0e16, z: -3.8e16
    }
    :ets.insert(:nullsec_sde_systems, {30000142, sys})

    :ok
  end

  test "get_intel_for returns error for unknown system" do
    start_supervised!(Aggregator)
    assert {:error, :unknown_system} = Aggregator.get_intel_for(999_999_999)
  end

  test "get_intel_for returns ok with list for known system" do
    start_supervised!(Aggregator)
    start_supervised!(WandererNullsec.Routes.RouteClient)

    # Pre-populate route cache to avoid HTTP call to route service
    :ets.insert(:nullsec_route_cache, {
      {30000142, 30000142},
      %{route: [30000142], jumps: 0},
      System.monotonic_time(:millisecond)
    })

    SystemCache.put({:kills, 30000142}, %{npc: 10, ship: 1, pod: 0})
    SystemCache.put({:jumps, 30000142}, %{jumps: 50})

    {:ok, entries} = Aggregator.get_intel_for(30000142)
    assert is_list(entries)
    jita = Enum.find(entries, fn e -> e.solar_system_id == 30000142 end)
    assert jita != nil
    assert jita.npc_kills == 10
  end
end
