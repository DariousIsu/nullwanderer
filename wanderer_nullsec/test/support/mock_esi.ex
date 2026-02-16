defmodule WandererNullsec.Test.MockESI do
  @moduledoc """
  Bypass plug for intercepting Req HTTP calls in tests.
  Usage:
    Req.Test.stub(:esi_mock, fn conn -> MockESI.handle(conn) end)
  """

  import Plug.Conn

  def kills_200 do
    fn conn ->
      body = Jason.encode!([
        %{"system_id" => 30000142, "npc_kills" => 25, "ship_kills" => 3, "pod_kills" => 1},
        %{"system_id" => 30000143, "npc_kills" => 10, "ship_kills" => 0, "pod_kills" => 0}
      ])
      conn
      |> put_resp_header("content-type", "application/json")
      |> put_resp_header("etag", "W/\"abc123\"")
      |> send_resp(200, body)
    end
  end

  def not_modified do
    fn conn ->
      send_resp(conn, 304, "")
    end
  end

  def rate_limited(retry_after_sec \\ 60) do
    fn conn ->
      conn
      |> put_resp_header("retry-after", to_string(retry_after_sec))
      |> send_resp(429, "")
    end
  end

  def server_error do
    fn conn -> send_resp(conn, 500, "Internal Server Error") end
  end

  def jumps_200 do
    fn conn ->
      body = Jason.encode!([
        %{"system_id" => 30000142, "ship_jumps" => 47},
        %{"system_id" => 30000143, "ship_jumps" => 12}
      ])
      conn
      |> put_resp_header("content-type", "application/json")
      |> send_resp(200, body)
    end
  end

  def sov_200 do
    fn conn ->
      body = Jason.encode!([
        %{"system_id" => 30000142, "alliance_id" => 99005338,
          "corporation_id" => nil, "faction_id" => nil}
      ])
      conn
      |> put_resp_header("content-type", "application/json")
      |> send_resp(200, body)
    end
  end

  def route_200(origin, dest) do
    fn conn ->
      route = [origin, 30000500, 30000501, dest]
      body = Jason.encode!(route)
      conn
      |> put_resp_header("content-type", "application/json")
      |> send_resp(200, body)
    end
  end

  def route_404 do
    fn conn -> send_resp(conn, 404, "") end
  end
end
