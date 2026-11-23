import { CircleCheckIcon, OctagonAlertIcon, TriangleAlertIcon } from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import { cn } from "@/lib/utils";

import { type Rating, RATINGS } from "./format";

/** The same icons and status colors as StatusBadge's tones, for a mark without a badge. */
const ICONS: Record<Rating, { icon: typeof CircleCheckIcon; className: string }> = {
  good: { icon: CircleCheckIcon, className: "text-status-good" },
  needsImprovement: { icon: TriangleAlertIcon, className: "text-warning" },
  poor: { icon: OctagonAlertIcon, className: "text-status-critical" },
};

const labelOf = (rating: Rating) => RATINGS.find((item) => item.value === rating)?.label ?? "";

export function RatingBadge({ rating }: { rating: Rating | null }) {
  if (rating === null) {
    return <StatusBadge tone="neutral">Not measured</StatusBadge>;
  }
  const tone = RATINGS.find((item) => item.value === rating)?.tone ?? "good";
  return <StatusBadge tone={tone}>{labelOf(rating)}</StatusBadge>;
}

/** Set named=false when the rating name is already visible. */
export function RatingIcon({ rating, named = true }: { rating: Rating; named?: boolean }) {
  const { icon: Icon, className } = ICONS[rating];
  const label = labelOf(rating);
  const icon = <Icon aria-hidden="true" className={cn("size-3.5 shrink-0", className)} />;
  if (!named) {
    return icon;
  }
  return (
    <span title={label} className="inline-flex">
      {icon}
      <span className="sr-only">{label}</span>
    </span>
  );
}
