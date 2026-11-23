import type { LogVolume, SeverityLevel } from "@/lib/logs-api";

import type { BarPart } from "./stacked-bar-chart";

/** Use status colors for errors and warnings, neutrals for the rest. Put errors on the baseline so their heights can be compared. */
export const SEVERITY_GROUPS: {
  key: string;
  label: string;
  color: string;
  levels: SeverityLevel[];
}[] = [
  {
    key: "error",
    label: "Error or worse",
    color: "var(--status-critical)",
    levels: ["error", "fatal"],
  },
  { key: "warn", label: "Warning", color: "var(--status-warning)", levels: ["warn"] },
  { key: "info", label: "Info", color: "var(--chart-neutral)", levels: ["info"] },
  {
    key: "other",
    label: "Debug, trace, or none",
    color: "var(--ink-tertiary)",
    levels: ["debug", "trace", "none"],
  },
];

export function severityParts(volume: LogVolume): BarPart[] {
  return SEVERITY_GROUPS.map((group) => ({
    key: group.key,
    label: group.label,
    color: group.color,
    values: Array.from({ length: volume.buckets }, (_, index) =>
      group.levels.reduce((sum, level) => sum + (volume.counts[level][index] ?? 0), 0),
    ),
  }));
}
