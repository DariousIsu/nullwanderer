import React from "react";
import { IntelEntry } from "./types";
import { DeltaIndicator } from "./DeltaIndicator";
import { SovBadge } from "./SovBadge";
import { RouteDetail } from "./RouteDetail";

interface SystemRowProps {
  entry: IntelEntry;
  visibleColumns: Set<string>;
}

function secColor(sec: number): string {
  if (sec >= -0.1) return "#f59e0b";
  if (sec >= -0.2) return "#ef4444";
  return "#991b1b";
}

export const SystemRow: React.FC<SystemRowProps> = ({ entry, visibleColumns }) => {
  return (
    <tr style={{ borderBottom: "1px solid #1e293b" }}>
      {visibleColumns.has("name") && (
        <td style={{ padding: "4px 8px", color: "#e2e8f0" }}>
          <a
            href={`https://dotlan.net/system/${encodeURIComponent(entry.name)}`}
            target="_blank"
            rel="noreferrer"
            style={{ color: "#60a5fa", textDecoration: "none" }}
          >
            {entry.name}
          </a>
        </td>
      )}
      {visibleColumns.has("distance_ly") && (
        <td style={{ padding: "4px 8px", textAlign: "right", color: "#94a3b8" }}>
          {entry.distance_ly.toFixed(2)}
        </td>
      )}
      {visibleColumns.has("gate_jumps") && (
        <td style={{ padding: "4px 8px", textAlign: "right" }}>
          <RouteDetail jumps={entry.gate_jumps} route={entry.gate_route} />
        </td>
      )}
      {visibleColumns.has("sov_alliance_ticker") && (
        <td style={{ padding: "4px 8px" }}>
          <SovBadge
            allianceTicker={entry.sov_alliance_ticker}
            allianceId={entry.sov_alliance_id}
            factionId={entry.sov_faction_id}
          />
        </td>
      )}
      {visibleColumns.has("npc_kills_delta") && (
        <td style={{ padding: "4px 8px", textAlign: "right" }}>
          <DeltaIndicator value={entry.npc_kills_delta} />
        </td>
      )}
      {visibleColumns.has("mining_cost_delta") && (
        <td style={{ padding: "4px 8px", textAlign: "right" }}>
          <DeltaIndicator
            value={entry.mining_cost_delta ? Math.round(entry.mining_cost_delta * 10000) : 0}
          />
        </td>
      )}
      {visibleColumns.has("jumps_per_hour") && (
        <td style={{ padding: "4px 8px", textAlign: "right", color: "#94a3b8" }}>
          {entry.jumps_per_hour}
        </td>
      )}
      {visibleColumns.has("pvp_ship_count_1hr") && (
        <td style={{ padding: "4px 8px", textAlign: "right", color: entry.pvp_ship_count_1hr > 0 ? "#f87171" : "#94a3b8" }}>
          {entry.pvp_ship_count_1hr}
        </td>
      )}
      {visibleColumns.has("security") && (
        <td style={{ padding: "4px 8px", textAlign: "right", color: secColor(entry.security) }}>
          {entry.security.toFixed(1)}
        </td>
      )}
      {visibleColumns.has("region_name") && (
        <td style={{ padding: "4px 8px", color: "#64748b", fontSize: "0.75rem" }}>
          {entry.region_name}
        </td>
      )}
      {visibleColumns.has("adm_value") && (
        <td style={{ padding: "4px 8px", textAlign: "right", color: "#94a3b8" }}>
          {entry.adm_value != null ? entry.adm_value.toFixed(1) : "—"}
        </td>
      )}
    </tr>
  );
};
