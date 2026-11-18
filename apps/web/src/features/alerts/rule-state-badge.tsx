import { CirclePowerIcon } from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import type { Rule } from "@/lib/alerts-api";

/** Whether a rule is off, firing, or quiet, in words beside the icon. */
export function RuleStateBadge({ rule }: { rule: Pick<Rule, "enabled" | "firing"> }) {
  if (!rule.enabled) {
    return (
      <StatusBadge tone="neutral" icon={<CirclePowerIcon aria-hidden="true" />}>
        Off
      </StatusBadge>
    );
  }
  if (rule.firing > 0) {
    return (
      <StatusBadge tone="critical">
        {rule.firing === 1 ? "Firing" : `Firing for ${rule.firing}`}
      </StatusBadge>
    );
  }
  return <StatusBadge tone="good">Quiet</StatusBadge>;
}
