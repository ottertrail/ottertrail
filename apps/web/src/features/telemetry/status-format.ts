import { STATUS_CLASSES, type StatusClass, type StatusCounts } from "@/lib/services-api";

import { formatConversion, formatWhole } from "../analytics/format";
import { OTHER_COLOR, SLOTS } from "./split-colors";

/** Keep status-class colors stable across charts. Use categorical colors and gray for No status. */

export const STATUS_LABELS: Record<StatusClass, string> = {
  "2xx": "2xx",
  "3xx": "3xx",
  "4xx": "4xx",
  "5xx": "5xx",
  none: "No status",
};

export const STATUS_COLORS: Record<StatusClass, string> = {
  "2xx": SLOTS[0] ?? OTHER_COLOR,
  "3xx": SLOTS[1] ?? OTHER_COLOR,
  "4xx": SLOTS[2] ?? OTHER_COLOR,
  "5xx": SLOTS[3] ?? OTHER_COLOR,
  none: OTHER_COLOR,
};

export function statusText(statuses: StatusCounts): string {
  const total = STATUS_CLASSES.reduce((sum, name) => sum + statuses[name], 0);
  if (total === 0) return "no requests";
  return STATUS_CLASSES.filter((name) => statuses[name] > 0)
    .map(
      (name) =>
        `${STATUS_LABELS[name]} ${formatWhole(statuses[name])} (${formatConversion(statuses[name] / total)})`,
    )
    .join(", ");
}
