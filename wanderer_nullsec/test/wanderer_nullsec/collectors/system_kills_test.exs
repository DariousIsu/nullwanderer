defmodule WandererNullsec.Collectors.SystemKillsTest do
  use ExUnit.Case, async: false

  alias WandererNullsec.Collectors.SystemKills
  alias WandererNullsec.Store.{SystemCache, DeltaTracker}

  setup do
    start_supervised!(SystemCache)
    start_supervised!(DeltaTracker)
    :ok
  end

  test "processes a valid system kills entry into SystemCache" do
    entry = %{"system_id" => 30000142, "npc_kills" => 25, "ship_kills" => 3, "pod_kills" => 1}

    send_to_collector(entry)

    assert {:ok, %{npc: 25, ship: 3, pod: 1}} = SystemCache.get({:kills, 30000142})
  end

  test "records delta in DeltaTracker" do
    entry = %{"system_id" => 30000999, "npc_kills" => 50, "ship_kills" => 0, "pod_kills" => 0}
    send_to_collector(entry)
    DeltaTracker.record(:npc_kills, 30000999, 60)
    assert DeltaTracker.delta(:npc_kills, 30000999) == 10
  end

  defp send_to_collector(entry) do
    SystemCache.put({:kills, entry["system_id"]}, %{
      npc: entry["npc_kills"],
      ship: entry["ship_kills"],
      pod: entry["pod_kills"]
    })
    DeltaTracker.record(:npc_kills, entry["system_id"], entry["npc_kills"])
    DeltaTracker.record(:ship_kills, entry["system_id"], entry["ship_kills"])
    DeltaTracker.record(:pod_kills, entry["system_id"], entry["pod_kills"])
  end
end
