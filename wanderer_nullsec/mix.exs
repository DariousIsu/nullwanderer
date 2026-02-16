defmodule WandererNullsec.MixProject do
  use Mix.Project

  def project do
    [
      app: :wanderer_nullsec,
      version: "0.1.0",
      elixir: "~> 1.15",
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      description: "Nullsec regional intel plugin for Wanderer EVE mapper",
      # Include SDE priv files in releases
      releases: [
        wanderer_nullsec: [
          steps: [:assemble],
          strip_beams: false
        ]
      ]
    ]
  end

  def application do
    [
      extra_applications: [:logger],
      mod: {WandererNullsec.Application, []}
    ]
  end

  defp deps do
    [
      # HTTP client — matches Wanderer's own stack (Tesla + Finch)
      {:tesla, "~> 1.11"},
      {:finch, "~> 0.13"},

      # JSON — matches Wanderer
      {:jason, "~> 1.4"},

      # Req for simpler HTTP (route builder + RedisQ long-poll).
      # Follows redirects automatically — required since RedisQ /listen.php
      # redirects to /object.php?objectID=<id> as of Aug 2025.
      {:req, "~> 0.5"},

      # Phoenix PubSub — already a dep of Wanderer, no version conflict
      {:phoenix_pubsub, "~> 2.1"},

      # Telemetry for ESI error budget tracking
      {:telemetry, "~> 1.0"},

      # SDE CSV loading (nullsec_systems.csv bundled in priv/sde/)
      {:csv, "~> 3.2"},

      # Dev/test
      {:ex_doc, "~> 0.27", only: :dev, runtime: false},
      {:mock, "~> 0.3", only: :test}
    ]
  end
end
