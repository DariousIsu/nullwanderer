import React, { useState } from "react";

interface RouteDetailProps {
  jumps: number | null;
  route: number[] | null;
}

export const RouteDetail: React.FC<RouteDetailProps> = ({ jumps, route }) => {
  const [expanded, setExpanded] = useState(false);

  if (jumps === null) return <span style={{ color: "#6b7280" }}>…</span>;
  if (jumps === 0 && (!route || route.length <= 1)) {
    return <span style={{ color: "#6b7280" }}>—</span>;
  }

  const displayJumps = jumps === -1 ? "∞" : jumps;

  return (
    <span>
      <button
        onClick={() => setExpanded((e) => !e)}
        style={{
          background: "none",
          border: "none",
          color: "#60a5fa",
          cursor: "pointer",
          padding: 0,
          fontSize: "inherit",
        }}
        title={expanded ? "Collapse route" : "Expand route"}
      >
        {displayJumps} {expanded ? "▲" : "▼"}
      </button>
      {expanded && route && route.length > 0 && (
        <div style={{ marginTop: "4px", fontSize: "0.7rem", color: "#94a3b8" }}>
          {route.join(" → ")}
        </div>
      )}
    </span>
  );
};
