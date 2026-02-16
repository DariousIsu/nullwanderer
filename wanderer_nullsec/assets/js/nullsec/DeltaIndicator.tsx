import React from "react";

interface DeltaIndicatorProps {
  value: number;
  threshold?: number;
}

export const DeltaIndicator: React.FC<DeltaIndicatorProps> = ({
  value,
  threshold = 0,
}) => {
  if (value === 0 || Math.abs(value) <= threshold) {
    return <span style={{ color: "#6b7280" }}>—</span>;
  }
  const isUp = value > 0;
  const color = isUp ? "#f87171" : "#4ade80";
  const arrow = isUp ? "↑" : "↓";
  return (
    <span style={{ fontFamily: "monospace", color }}>
      {arrow}{Math.abs(value)}
    </span>
  );
};
