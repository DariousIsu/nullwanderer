defmodule WandererNullsec.MixProject do
  use Mix.Project

  def project do
    [
      app: :wanderer_nullsec,
      version: "0.1.0",
      elixir: "~> 1.15",
      start_permanent: Mix.env() == :prod,
      elixirc_paths: elixirc_paths(Mix.env()),
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

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  def application do
    [
      extra_applications: [:logger]
    ] ++ app_mod(Mix.env())
  end

  defp app_mod(:test), do: []
  defp app_mod(_), do: [mod: {WandererNullsec.Application, []}]

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

      # Phoenix — needed for Phoenix.Controller in IntelController
      {:phoenix, "~> 1.7"},

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
