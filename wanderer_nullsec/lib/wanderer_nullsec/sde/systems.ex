defmodule WandererNullsec.SDE.Systems do
  @moduledoc """
  Loads nullsec system coordinates from a bundled SDE CSV at startup.
  Stores all systems in ETS for O(1) lookup and efficient distance filtering.

  ## Data Source

  Wanderer's database does NOT store x/y/z coordinates — confirmed from the
  public API schema (/api/common/system-static-info) which contains no
  position fields. Wanderer is a wormhole mapper; wormhole systems have no
  fixed universe position, so 3D coordinates are never needed internally.

  The plugin therefore bundles its own SDE extract:

      priv/sde/nullsec_systems.csv

  Required columns:
      solarSystemID, solarSystemName, security, regionID, regionName,
      constellationID, constellationName, x, y, z

  Generate with (Fuzzwork postgres SDE):

      SELECT s."solarSystemID", s."solarSystemName", s.security,
             s."regionID", r."regionName", s."constellationID",
             c."constellationName", s.x, s.y, s.z
      FROM "mapSolarSystems" s
      JOIN "mapRegions"       r ON r."regionID"         = s."regionID"
      JOIN "mapConstellations" c ON c."constellationID" = s."constellationID"
      WHERE s.security < 0.0
        AND s."solarSystemID" < 31000000
      ORDER BY s."solarSystemID";

  ## Coordinate Units

  SDE x/y/z values are in **metres** (confirmed from Fuzzwork SDE guide and
  EVE developer documentation). Convert to light-years:

      1 LY = 9.4607 × 10¹⁵ metres
      dist_ly = sqrt(Δx² + Δy² + Δz²) / 9.4607e15

  Typical nullsec values: ±1×10¹⁶ to ±1×10¹⁷ metres.
  The 8 LY default radius = 7.569 × 10¹⁶ metres.

  ## Filter Logic

  - security < 0.0          → excludes highsec (≥ 0.5) and lowsec (0.1–0.4)
  - security >= -1.0         → excludes wormhole systems (security == -1.0)
  - solar_system_id < 31_000_000 → belt-and-suspenders WH exclusion (WH IDs ≥ 31000001)
  - Pochven systems are in k-space ID range but have security -0.99; they will
    be included by the filter. This is intentional — Pochven borders nullsec.
  """

  use GenServer

  require Logger

  alias WandererNullsec.Types.SDESystem

  @ets_table :nullsec_sde_systems
  # 1 light-year in metres (IAU 2012 definition)
  @ly_to_metres 9.4607e15

  # ---------------------------------------------------------------------------
  # Public API
  # ---------------------------------------------------------------------------

  def start_link(_opts), do: GenServer.start_link(__MODULE__, [], name: __MODULE__)

  @doc "Get SDE data for a system by ID. Returns %SDESystem{} or nil."
  @spec get(integer()) :: SDESystem.t() | nil
  def get(system_id) do
    case :ets.lookup(@ets_table, system_id) do
      [{^system_id, sys}] -> sys
      [] -> nil
    end
  end

  @doc """
  Get all nullsec systems within `radius_ly` light-years of the given
  {x, y, z} coordinates (in metres).

  Returns a list of `{%SDESystem{}, distance_ly}` tuples, sorted by
  distance ascending (closest first).
  """
  @spec systems_within_ly({float(), float(), float()}, float()) :: [{SDESystem.t(), float()}]
  def systems_within_ly({cx, cy, cz}, radius_ly) do
    radius_m = radius_ly * @ly_to_metres

    :ets.foldl(
      fn {_id, sys}, acc ->
        dx = sys.x - cx
        dy = sys.y - cy
        dz = sys.z - cz
        dist_m = :math.sqrt(dx * dx + dy * dy + dz * dz)

        if dist_m <= radius_m do
          dist_ly = Float.round(dist_m / @ly_to_metres, 2)
          [{sys, dist_ly} | acc]
        else
          acc
        end
      end,
      [],
      @ets_table
    )
    |> Enum.sort_by(fn {_sys, dist} -> dist end)
  end

  @doc "Returns the total number of nullsec systems loaded."
  def count do
    :ets.info(@ets_table, :size)
  end

  # ---------------------------------------------------------------------------
  # GenServer callbacks
  # ---------------------------------------------------------------------------

  @impl true
  def init(_) do
    table = :ets.new(@ets_table, [:named_table, :set, :public, read_concurrency: true])

    case load_from_csv() do
      {:ok, systems} ->
        Enum.each(systems, fn sys ->
          :ets.insert(table, {sys.solar_system_id, sys})
        end)

        count = length(systems)
        Logger.info("WandererNullsec.SDE.Systems: loaded #{count} nullsec systems from CSV")
        {:ok, %{count: count}}

      {:error, reason} ->
        Logger.error("WandererNullsec.SDE.Systems: failed to load CSV: #{inspect(reason)}")
        {:stop, {:csv_load_failed, reason}}
    end
  end

  # ---------------------------------------------------------------------------
  # Private — CSV loading
  # ---------------------------------------------------------------------------

  defp load_from_csv do
    path = Application.app_dir(:wanderer_nullsec, "priv/sde/nullsec_systems.csv")

    unless File.exists?(path) do
      {:error, {:file_not_found, path}}
    else
      systems =
        path
        |> File.stream!()
        |> CSV.decode!(headers: true)
        |> Stream.map(&parse_sde_row/1)
        |> Stream.filter(&valid_nullsec?/1)
        |> Enum.to_list()

      {:ok, systems}
    end
  rescue
    e -> {:error, e}
  end

  defp parse_sde_row(row) do
    %SDESystem{
      solar_system_id: parse_int(row["solarSystemID"]),
      name: row["solarSystemName"],
      security: parse_float(row["security"]),
      region_id: parse_int(row["regionID"]),
      region_name: row["regionName"],
      constellation_id: parse_int(row["constellationID"]),
      constellation_name: row["constellationName"],
      # SDE coordinates are in metres (DOUBLE PRECISION in postgres SDE)
      x: parse_float(row["x"]),
      y: parse_float(row["y"]),
      z: parse_float(row["z"])
    }
  end

  defp valid_nullsec?(%SDESystem{security: sec, solar_system_id: id}) do
    # Exclude wormholes (security == -1.0 exactly, and ID >= 31_000_000)
    sec < 0.0 and sec > -1.0 and id < 31_000_000
  end

  defp parse_int(s), do: String.to_integer(String.trim(s))

  defp parse_float(s) do
    s = String.trim(s)
    case Float.parse(s) do
      {f, _} -> f
      :error -> String.to_integer(s) * 1.0
    end
  end
end
