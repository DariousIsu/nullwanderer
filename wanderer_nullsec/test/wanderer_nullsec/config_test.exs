defmodule WandererNullsec.ConfigTest do
  use ExUnit.Case, async: true

  alias WandererNullsec.Config

  test "returns float for intel_radius_ly" do
    assert is_float(Config.intel_radius_ly())
    assert Config.intel_radius_ly() > 0.0
  end

  test "returns string for esi_base_url" do
    assert is_binary(Config.esi_base_url())
    assert String.starts_with?(Config.esi_base_url(), "http")
  end

  test "returns string for route_builder_url" do
    assert is_binary(Config.route_builder_url())
  end

  test "returns positive integer for route_cache_ttl_ms" do
    assert Config.route_cache_ttl_ms() > 0
  end

  test "returns positive integer for delta_window_ms" do
    assert Config.delta_window_ms() > 0
  end

  test "returns positive integer for esi_poll_interval_ms" do
    assert Config.esi_poll_interval_ms() > 0
  end

  test "in test env, esi_base_url points to localhost" do
    assert Config.esi_base_url() =~ "localhost"
  end

  test "pubsub_server is an atom" do
    assert is_atom(Config.pubsub_server())
  end
end
