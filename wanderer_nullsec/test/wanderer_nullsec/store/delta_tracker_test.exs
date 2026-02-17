defmodule WandererNullsec.Store.DeltaTrackerTest do
  use ExUnit.Case, async: false

  alias WandererNullsec.Store.DeltaTracker

  setup do
    start_supervised!(DeltaTracker)
    :ok
  end

  test "delta returns 0 with no data" do
    assert DeltaTracker.delta(:npc_kills, 9999) == 0
  end

  test "delta returns 0 with only one snapshot" do
    DeltaTracker.record(:npc_kills, 1001, 100)
    assert DeltaTracker.delta(:npc_kills, 1001) == 0
  end

  test "delta returns current - oldest with two snapshots" do
    DeltaTracker.record(:npc_kills, 1001, 100)
    DeltaTracker.record(:npc_kills, 1001, 150)
    assert DeltaTracker.delta(:npc_kills, 1001) == 50
  end

  test "delta is signed — negative when activity decreases" do
    DeltaTracker.record(:jumps, 1001, 200)
    DeltaTracker.record(:jumps, 1001, 180)
    assert DeltaTracker.delta(:jumps, 1001) == -20
  end

  test "record works with float values" do
    DeltaTracker.record(:mining_cost, 1001, 0.020)
    DeltaTracker.record(:mining_cost, 1001, 0.045)
    delta = DeltaTracker.delta(:mining_cost, 1001)
    assert_in_delta delta, 0.025, 0.001
  end

  test "clear resets all data" do
    DeltaTracker.record(:npc_kills, 1001, 100)
    DeltaTracker.record(:npc_kills, 1001, 200)
    DeltaTracker.clear()
    assert DeltaTracker.delta(:npc_kills, 1001) == 0
  end

  test "different metrics are tracked independently" do
    DeltaTracker.record(:npc_kills, 1001, 10)
    DeltaTracker.record(:npc_kills, 1001, 20)
    DeltaTracker.record(:jumps, 1001, 100)
    DeltaTracker.record(:jumps, 1001, 90)
    assert DeltaTracker.delta(:npc_kills, 1001) == 10
    assert DeltaTracker.delta(:jumps, 1001) == -10
  end
end
