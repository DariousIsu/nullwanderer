import Config

config :wanderer_nullsec,
  esi_base_url: "https://esi.evetech.net",
  route_builder_url: "http://eve-route-builder:2001",
  redisq_url: "https://zkillredisq.stream/listen.php",
  intel_radius_ly: 8.0,
  route_cache_ttl_ms: :timer.hours(24),
  delta_window_ms: :timer.hours(6),
  esi_poll_interval_ms: :timer.minutes(10),
  sov_poll_interval_ms: :timer.minutes(30),
  adm_poll_interval_ms: :timer.minutes(5),
  pubsub_server: WandererApp.PubSub

if Mix.env() == :test do
  config :wanderer_nullsec,
    esi_base_url: "http://localhost:8765",
    route_builder_url: "http://localhost:8766",
    redisq_url: "http://localhost:8767/listen.php",
    intel_radius_ly: 8.0,
    pubsub_server: WandererNullsec.TestPubSub
end
