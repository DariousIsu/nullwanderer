defmodule WandererNullsec.SDE.SystemsTest do
  use ExUnit.Case, async: false

  alias WandererNullsec.SDE.Systems

  describe "systems_within_ly/2" do
    test "includes systems within radius" do
      one_ly = 9.4607e15
      origin = {0.0, 0.0, 0.0}

      sys = %WandererNullsec.Types.SDESystem{
        solar_system_id: 30000001,
        name: "TestSystem",
        security: -0.5,
        region_id: 1,
        region_name: "TestRegion",
        constellation_id: 1,
        constellation_name: "TestConst",
        x: 3.0 * one_ly,
        y: 0.0,
        z: 0.0
      }

      :ets.insert(:nullsec_sde_systems, {sys.solar_system_id, sys})

      results = Systems.systems_within_ly(origin, 5.0)
      found = Enum.find(results, fn {s, _dist} -> s.solar_system_id == 30000001 end)
      assert found != nil
      {_sys, dist} = found
      assert_in_delta dist, 3.0, 0.01
    end

    test "excludes systems beyond radius" do
      one_ly = 9.4607e15
      origin = {0.0, 0.0, 0.0}

      far_sys = %WandererNullsec.Types.SDESystem{
        solar_system_id: 30099999,
        name: "FarAway",
        security: -0.4,
        region_id: 1,
        region_name: "TestRegion",
        constellation_id: 1,
        constellation_name: "TestConst",
        x: 20.0 * one_ly,
        y: 0.0,
        z: 0.0
      }

      :ets.insert(:nullsec_sde_systems, {far_sys.solar_system_id, far_sys})

      results = Systems.systems_within_ly(origin, 8.0)
      found = Enum.find(results, fn {s, _} -> s.solar_system_id == 30099999 end)
      assert found == nil
    end

    test "results are sorted by distance ascending" do
      one_ly = 9.4607e15
      origin = {0.0, 0.0, 0.0}

      for {id, dist} <- [{30000200, 5.0}, {30000201, 2.0}, {30000202, 7.0}] do
        sys = %WandererNullsec.Types.SDESystem{
          solar_system_id: id, name: "Sys#{id}", security: -0.5,
          region_id: 1, region_name: "R", constellation_id: 1, constellation_name: "C",
          x: dist * one_ly, y: 0.0, z: 0.0
        }
        :ets.insert(:nullsec_sde_systems, {id, sys})
      end

      results = Systems.systems_within_ly(origin, 10.0)
      relevant = Enum.filter(results, fn {s, _} -> s.solar_system_id in [30000200, 30000201, 30000202] end)
      distances = Enum.map(relevant, fn {_, d} -> d end)
      assert distances == Enum.sort(distances)
    end
  end

  describe "get/1" do
    test "returns nil for unknown system" do
      assert Systems.get(999999) == nil
    end
  end
end
