defmodule WandererNullsec.Publisher do
  @moduledoc """
  Broadcasts IntelEntry updates to WandererApp.PubSub.

  Topic format: "nullsec:intel:{entry_system_id}"

  Frontend subscribes via LiveView hook and receives:
    {:nullsec_intel_update, [%IntelEntry{}, ...]}

  The Publisher itself is stateless — it is a thin wrapper around
  Phoenix.PubSub that centralises topic naming.
  """

  use GenServer

  def start_link(_opts), do: GenServer.start_link(__MODULE__, [], name: __MODULE__)

  @impl true
  def init(_), do: {:ok, %{}}

  @doc "Broadcast a list of IntelEntry structs for a given entry system."
  def broadcast(entry_system_id, intel_entries) when is_integer(entry_system_id) do
    server = WandererNullsec.Config.pubsub_server()
    topic  = topic_for(entry_system_id)
    Phoenix.PubSub.broadcast(server, topic, {:nullsec_intel_update, intel_entries})
  end

  @doc "Subscribe to intel updates for a given entry system (from LiveView)."
  def subscribe(entry_system_id) when is_integer(entry_system_id) do
    server = WandererNullsec.Config.pubsub_server()
    Phoenix.PubSub.subscribe(server, topic_for(entry_system_id))
  end

  @doc "Canonical topic name for a given entry system ID."
  def topic_for(system_id), do: "nullsec:intel:#{system_id}"
end
