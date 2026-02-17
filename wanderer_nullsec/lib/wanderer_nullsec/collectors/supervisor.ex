defmodule WandererNullsec.Collectors.Supervisor do
  @moduledoc """
  DynamicSupervisor for ESI data collectors.
  All collectors are started on init with :transient restart strategy —
  a collector crash does not bring down the rest of the plugin.
  """

  use Supervisor

  def start_link(_opts), do: Supervisor.start_link(__MODULE__, [], name: __MODULE__)

  @impl true
  def init(_opts) do
    children = [
      WandererNullsec.Collectors.SystemKills,
      WandererNullsec.Collectors.SystemJumps,
      WandererNullsec.Collectors.Sovereignty,
      WandererNullsec.Collectors.SovStructures,
      WandererNullsec.Collectors.Industry
    ]

    Supervisor.init(children, strategy: :one_for_one)
  end
end
