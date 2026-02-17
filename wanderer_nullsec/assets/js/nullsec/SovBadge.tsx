import React from "react";

interface SovBadgeProps {
  allianceTicker: string | null;
  allianceId: number | null;
  factionId: number | null;
}

export const SovBadge: React.FC<SovBadgeProps> = ({
  allianceTicker,
  allianceId,
  factionId,
}) => {
  if (factionId) {
    return <span style={{ color: "#94a3b8", fontSize: "0.75rem" }}>NPC</span>;
  }
  if (!allianceTicker) {
    return <span style={{ color: "#475569" }}>—</span>;
  }
  const logoUrl = allianceId
    ? `https://images.evetech.net/alliances/${allianceId}/logo?size=32`
    : undefined;
  return (
    <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
      {logoUrl && (
        <img
          src={logoUrl}
          alt={allianceTicker}
          width={16}
          height={16}
          style={{ borderRadius: "2px" }}
          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
        />
      )}
      <span style={{ fontSize: "0.75rem", color: "#e2e8f0" }}>
        {allianceTicker}
      </span>
    </span>
  );
};
