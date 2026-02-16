ExUnit.start()

# Start a test PubSub server so Publisher tests don't need Wanderer running.
{:ok, _} = Phoenix.PubSub.start_link(name: WandererNullsec.TestPubSub)
