defmodule WandererNullsec.Routes.RouteClientTest do
  use ExUnit.Case, async: false

  alias WandererNullsec.Routes.RouteClient

  setup do
    start_supervised!(RouteClient)
    :ok
  end

  test "route cache ETS table is created on start" do
    assert :ets.info(:nullsec_route_cache) != :undefined
  end

  test "caches a route after successful fetch" do
    entry = %{route: [30000142, 30000143, 30000144], jumps: 2}
    now = System.monotonic_time(:millisecond)
    :ets.insert(:nullsec_route_cache, {{30000142, 30000144}, entry, now})

    {:ok, result} = RouteClient.get_route(30000142, 30000144)
    assert result.jumps == 2
    assert length(result.route) == 3
  end

  test "returns no_route for cached no-route entry" do
    entry = %{route: [], jumps: :no_route}
    now = System.monotonic_time(:millisecond)
    :ets.insert(:nullsec_route_cache, {{30000142, 99999999}, entry, now})

    {:ok, result} = RouteClient.get_route(30000142, 99999999)
    assert result.jumps == :no_route
  end
end
