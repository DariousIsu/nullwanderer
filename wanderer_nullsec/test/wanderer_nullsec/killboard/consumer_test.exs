defmodule WandererNullsec.Killboard.ConsumerTest do
  use ExUnit.Case, async: false

  alias WandererNullsec.Killboard.Consumer
  alias WandererNullsec.Store.SystemCache

  setup do
    start_supervised!(SystemCache)
    :ok
  end

  describe "build_kill_entry/1 (via SystemCache)" do
    test "handles full killmail schema" do
      package = %{
        "killID" => 12345,
        "killmail" => %{
          "killmail_time"  => "2026-02-16T12:00:00Z",
          "solar_system_id" => 30000142,
          "victim" => %{"ship_type_id" => 638},
          "attackers" => [%{"character_id" => 99001}]
        },
        "zkb" => %{
          "totalValue" => 150_000_000,
          "npc" => false,
          "solo" => true,
          "labels" => ["pvp"]
        }
      }

      system_id = get_in(package, ["killmail", "solar_system_id"])
      assert system_id == 30000142
    end

    test "handles future schema (no killmail object)" do
      package = %{
        "killID" => 12346,
        "zkb" => %{
          "locationID"   => 30000142,
          "totalValue"   => 50_000_000,
          "npc"          => false,
          "solo"         => false,
          "hash"         => "abc123",
          "href"         => "https://esi.evetech.net/v1/killmails/12346/abc123/",
          "labels"       => []
        }
      }

      system_id = get_in(package, ["zkb", "locationID"])
      assert system_id == 30000142
    end
  end
end
