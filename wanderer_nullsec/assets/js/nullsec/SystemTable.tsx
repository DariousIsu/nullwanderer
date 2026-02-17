import React from "react";
import { IntelEntry, SortField, SortDir } from "./types";
import { SystemRow } from "./SystemRow";

interface Column {
  key: string;
  label: string;
  sortable: boolean;
  defaultVisible: boolean;
}

const COLUMNS: Column[] = [
  { key: "name",               label: "System",    sortable: true,  defaultVisible: true  },
  { key: "distance_ly",        label: "LY",        sortable: true,  defaultVisible: true  },
  { key: "gate_jumps",         label: "Gates",     sortable: true,  defaultVisible: true  },
  { key: "sov_alliance_ticker",label: "Sov",       sortable: true,  defaultVisible: true  },
  { key: "npc_kills_delta",    label: "NPC Δ",     sortable: true,  defaultVisible: true  },
  { key: "mining_cost_delta",  label: "Mining Δ",  sortable: true,  defaultVisible: false },
  { key: "jumps_per_hour",     label: "Jumps/hr",  sortable: true,  defaultVisible: true  },
  { key: "pvp_ship_count_1hr", label: "PvP",       sortable: true,  defaultVisible: true  },
  { key: "security",           label: "Sec",       sortable: true,  defaultVisible: false },
  { key: "region_name",        label: "Region",    sortable: false, defaultVisible: false },
  { key: "adm_value",          label: "ADM",       sortable: true,  defaultVisible: false },
];

interface SystemTableProps {
  entries: IntelEntry[];
  sortField: SortField;
  sortDir: SortDir;
  visibleColumns: Set<string>;
  onSort: (field: SortField) => void;
}

export const SystemTable: React.FC<SystemTableProps> = ({
  entries,
  sortField,
  sortDir,
  visibleColumns,
  onSort,
}) => {
  const sortedEntries = [...entries].sort((a, b) => {
    const av = (a as Record<string, unknown>)[sortField];
    const bv = (b as Record<string, unknown>)[sortField];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return sortDir === "asc" ? cmp : -cmp;
  });

  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
      <thead>
        <tr style={{ background: "#0f172a", color: "#64748b", textTransform: "uppercase" }}>
          {COLUMNS.filter((c) => visibleColumns.has(c.key)).map((col) => (
            <th
              key={col.key}
              style={{
                padding: "6px 8px",
                textAlign: col.key === "name" ? "left" : "right",
                cursor: col.sortable ? "pointer" : "default",
                userSelect: "none",
                whiteSpace: "nowrap",
              }}
              onClick={col.sortable ? () => onSort(col.key as SortField) : undefined}
            >
              {col.label}
              {col.sortable && sortField === col.key && (
                <span style={{ marginLeft: "4px" }}>
                  {sortDir === "asc" ? "↑" : "↓"}
                </span>
              )}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sortedEntries.map((entry) => (
          <SystemRow
            key={entry.solar_system_id}
            entry={entry}
            visibleColumns={visibleColumns}
          />
        ))}
      </tbody>
    </table>
  );
};
