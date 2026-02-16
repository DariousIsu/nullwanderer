defmodule WandererNullsec.Collectors.SystemJumpsTest do
  use ExUnit.Case, async: false

  alias WandererNullsec.Store.{SystemCache, DeltaTracker}

  setup do
    start_supervised!(SystemCache)
    start_supervised!(DeltaTracker)
    :ok
  end

  test "processes jumps entry into SystemCache" do
    SystemCache.put({:jumps, 30000142}, %{jumps: 47})
    assert {:ok, %{jumps: 47}} = SystemCache.get({:jumps, 30000142})
  end

  test "delta tracks jump changes correctly" do
    DeltaTracker.record(:jumps, 30000142, 47)
    DeltaTracker.record(:jumps, 30000142, 62)
    assert DeltaTracker.delta(:jumps, 30000142) == 15
  end
end
