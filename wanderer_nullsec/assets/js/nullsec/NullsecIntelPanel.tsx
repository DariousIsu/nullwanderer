import React, { useState, useEffect } from "react";
import { IntelEntry, SortField, SortDir } from "./types";
import { SystemTable } from "./SystemTable";

const DEFAULT_COLUMNS = new Set([
  "name", "distance_ly", "gate_jumps", "sov_alliance_ticker",
  "npc_kills_delta", "jumps_per_hour", "pvp_ship_count_1hr",
]);

const ALL_COLUMN_KEYS = [
  "name", "distance_ly", "gate_jumps", "sov_alliance_ticker",
  "npc_kills_delta", "mining_cost_delta", "jumps_per_hour",
  "pvp_ship_count_1hr", "security", "region_name", "adm_value",
];

interface NullsecIntelPanelProps {
  entrySystemId: number;
  entrySystemName: string;
  initialData: IntelEntry[];
}

const NullsecIntelPanel: React.FC<NullsecIntelPanelProps> = ({
  entrySystemId,
  entrySystemName,
  initialData,
}) => {
  const [entries, setEntries] = useState<IntelEntry[]>(initialData);
  const [sortField, setSortField] = useState<SortField>("distance_ly");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(DEFAULT_COLUMNS);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [showColumnPicker, setShowColumnPicker] = useState(false);

  useEffect(() => {
    const handler = (event: CustomEvent<{ data: IntelEntry[] }>) => {
      setEntries(event.detail.data);
      setLastUpdated(new Date());
    };
    window.addEventListener(`nullsec_intel_update_${entrySystemId}`, handler as EventListener);
    return () => window.removeEventListener(`nullsec_intel_update_${entrySystemId}`, handler as EventListener);
  }, [entrySystemId]);

  const handleSort = (field: SortField) => {
    if (field === sortField) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  const toggleColumn = (key: string) => {
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div style={{
      background: "#0f172a", color: "#e2e8f0", fontFamily: "monospace",
      border: "1px solid #1e293b", borderRadius: "4px",
    }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "8px 12px", borderBottom: "1px solid #1e293b",
      }}>
        <div>
          <span style={{ color: "#60a5fa", fontWeight: "bold" }}>
            {entrySystemName}
          </span>
          <span style={{ color: "#475569", marginLeft: "8px", fontSize: "0.75rem" }}>
            {entries.length} systems within{" "}
            {parseFloat(String(8.0)).toFixed(0)} LY
          </span>
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <span style={{ color: "#475569", fontSize: "0.7rem" }}>
            {lastUpdated.toLocaleTimeString()}
          </span>
          <button
            onClick={() => setShowColumnPicker((v) => !v)}
            style={{
              background: "#1e293b", border: "1px solid #334155",
              color: "#94a3b8", borderRadius: "3px",
              padding: "2px 8px", cursor: "pointer", fontSize: "0.75rem",
            }}
          >
            Columns
          </button>
        </div>
      </div>

      {showColumnPicker && (
        <div style={{
          padding: "8px 12px", borderBottom: "1px solid #1e293b",
          display: "flex", flexWrap: "wrap", gap: "8px",
        }}>
          {ALL_COLUMN_KEYS.map((key) => (
            <label key={key} style={{ display: "flex", alignItems: "center", gap: "4px",
              fontSize: "0.75rem", color: "#94a3b8", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={visibleColumns.has(key)}
                onChange={() => toggleColumn(key)}
              />
              {key.replace(/_/g, " ")}
            </label>
          ))}
        </div>
      )}

      {entries.length === 0 ? (
        <div style={{ padding: "24px", textAlign: "center", color: "#475569" }}>
          No nullsec systems found within range.
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <SystemTable
            entries={entries}
            sortField={sortField}
            sortDir={sortDir}
            visibleColumns={visibleColumns}
            onSort={handleSort}
          />
        </div>
      )}
    </div>
  );
};

export default NullsecIntelPanel;
