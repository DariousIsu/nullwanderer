defmodule WandererNullsec.Store.SystemCacheTest do
  use ExUnit.Case, async: false

  alias WandererNullsec.Store.SystemCache

  setup do
    start_supervised!(SystemCache)
    :ok
  end

  test "put and get a kills entry" do
    SystemCache.put({:kills, 1001}, %{npc: 10, ship: 2, pod: 1})
    assert {:ok, %{npc: 10, ship: 2, pod: 1}} = SystemCache.get({:kills, 1001})
  end

  test "get returns error for missing key" do
    assert {:error, :not_found} = SystemCache.get({:kills, 9999})
  end

  test "put overwrites existing entry" do
    SystemCache.put({:jumps, 1001}, %{jumps: 10})
    SystemCache.put({:jumps, 1001}, %{jumps: 20})
    assert {:ok, %{jumps: 20}} = SystemCache.get({:jumps, 1001})
  end

  test "get_all_by_type returns all entries for a type" do
    SystemCache.put({:kills, 1001}, %{npc: 5})
    SystemCache.put({:kills, 1002}, %{npc: 3})
    SystemCache.put({:jumps, 1001}, %{jumps: 10})
    results = SystemCache.get_all_by_type(:kills)
    assert length(results) == 2
    system_ids = Enum.map(results, fn {id, _} -> id end) |> Enum.sort()
    assert system_ids == [1001, 1002]
  end

  test "push_pvp_kill adds to rolling window" do
    now = System.monotonic_time(:millisecond)
    kill = %{kill_id: 1, npc: false, recorded_at: now}
    SystemCache.push_pvp_kill(1001, kill)
    kills = SystemCache.get_pvp_kills(1001)
    assert length(kills) == 1
    assert hd(kills).kill_id == 1
  end

  test "push_pvp_kill prunes stale kills" do
    old_ts = System.monotonic_time(:millisecond) - :timer.hours(2)
    old_kill = %{kill_id: 1, npc: false, recorded_at: old_ts}
    SystemCache.push_pvp_kill(1001, old_kill)

    new_ts = System.monotonic_time(:millisecond)
    new_kill = %{kill_id: 2, npc: false, recorded_at: new_ts}
    SystemCache.push_pvp_kill(1001, new_kill)

    kills = SystemCache.get_pvp_kills(1001)
    assert length(kills) == 1
    assert hd(kills).kill_id == 2
  end

  test "get_pvp_kills returns empty list for unknown system" do
    assert [] = SystemCache.get_pvp_kills(9999)
  end
end
