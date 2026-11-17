import { StatusBadge } from "@/components/status-badge";
import type { ErrorStatus } from "@/lib/errors-api";

const BADGES = {
  unresolved: { tone: "neutral", label: "Unresolved" },
  regressed: { tone: "critical", label: "Regressed" },
  resolved: { tone: "good", label: "Resolved" },
} as const;

/** An error group's status, as an icon and a label. */
export function ErrorStatusBadge({ status }: { status: ErrorStatus }) {
  const { tone, label } = BADGES[status];
  return <StatusBadge tone={tone}>{label}</StatusBadge>;
}
