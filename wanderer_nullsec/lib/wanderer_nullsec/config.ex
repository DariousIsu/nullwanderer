defmodule WandererNullsec.Config do
  @moduledoc """
  Runtime configuration. All values read at call-time (not compile-time)
  so they pick up runtime.exs overrides in Wanderer's deployment.
  """

  def intel_radius_ly,
    do: Application.get_env(:wanderer_nullsec, :intel_radius_ly, 8.0)

  def esi_base_url,
    do: Application.get_env(:wanderer_nullsec, :esi_base_url, "https://esi.evetech.net")

  def route_builder_url,
    do: Application.get_env(:wanderer_nullsec, :route_builder_url, "http://eve-route-builder:2001")

  def redisq_url,
    do: Application.get_env(:wanderer_nullsec, :redisq_url, "https://zkillredisq.stream/listen.php")

  def route_cache_ttl_ms,
    do: Application.get_env(:wanderer_nullsec, :route_cache_ttl_ms, :timer.hours(24))

  def delta_window_ms,
    do: Application.get_env(:wanderer_nullsec, :delta_window_ms, :timer.hours(6))

  def esi_poll_interval_ms,
    do: Application.get_env(:wanderer_nullsec, :esi_poll_interval_ms, :timer.minutes(10))

  def sov_poll_interval_ms,
    do: Application.get_env(:wanderer_nullsec, :sov_poll_interval_ms, :timer.minutes(30))

  def adm_poll_interval_ms,
    do: Application.get_env(:wanderer_nullsec, :adm_poll_interval_ms, :timer.minutes(5))

  def pubsub_server,
    do: Application.get_env(:wanderer_nullsec, :pubsub_server, WandererApp.PubSub)
end
