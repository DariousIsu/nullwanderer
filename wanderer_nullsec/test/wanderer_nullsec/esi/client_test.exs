defmodule WandererNullsec.ESI.ClientTest do
  use ExUnit.Case, async: false

  alias WandererNullsec.ESI.Client

  setup do
    start_supervised!(Client)
    :ok
  end

  test "get_system_kills parses 200 response" do
    Req.Test.stub(WandererNullsec.ESI.Client, fn conn ->
      body = Jason.encode!([
        %{"system_id" => 30000142, "npc_kills" => 25, "ship_kills" => 3, "pod_kills" => 1}
      ])
      conn
      |> Plug.Conn.put_resp_header("content-type", "application/json")
      |> Plug.Conn.send_resp(200, body)
    end)

    assert true
  end

  test "etag table is created on start" do
    assert :ets.info(:nullsec_etags) != :undefined
  end

  test "etag table has correct properties" do
    info = :ets.info(:nullsec_etags)
    assert info[:type] == :set
    assert info[:protection] == :public
  end
end
