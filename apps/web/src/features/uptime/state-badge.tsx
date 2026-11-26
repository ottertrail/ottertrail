import { CirclePauseIcon } from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import type { Check } from "@/lib/uptime-api";

export function CheckStateBadge({ check }: { check: Pick<Check, "paused" | "state" | "kind"> }) {
  if (check.paused) {
    return (
      <StatusBadge tone="neutral" icon={<CirclePauseIcon aria-hidden="true" />}>
        Paused
      </StatusBadge>
    );
  }
  if (check.state === "up") return <StatusBadge tone="good">Up</StatusBadge>;
  if (check.state === "down") return <StatusBadge tone="critical">Down</StatusBadge>;
  return <StatusBadge tone="neutral">{check.kind === "heartbeat" ? "New" : "Pending"}</StatusBadge>;
}
