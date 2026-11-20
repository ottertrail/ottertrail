import {
  CircleCheckIcon,
  CircleDashedIcon,
  OctagonAlertIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type * as React from "react";

import { cn } from "@/lib/utils";

const tones = {
  good: { icon: CircleCheckIcon, className: "bg-status-good/15 text-status-good" },
  warning: { icon: TriangleAlertIcon, className: "bg-status-warning/15 text-warning" },
  critical: { icon: OctagonAlertIcon, className: "bg-status-critical/20 text-status-critical" },
  neutral: { icon: CircleDashedIcon, className: "bg-muted text-muted-foreground" },
} as const;

export type StatusTone = keyof typeof tones;

interface StatusBadgeProps extends React.ComponentProps<"span"> {
  tone: StatusTone;
  /** Replaces the tone's default icon, for example with a spinner. */
  icon?: React.ReactNode;
}

/**
 * State indicator. Status colors always appear with an icon and a text label,
 * never as color alone.
 */
export function StatusBadge({ tone, icon, className, children, ...props }: StatusBadgeProps) {
  const { icon: ToneIcon, className: toneClassName } = tones[tone];
  return (
    <span
      data-slot="status-badge"
      data-tone={tone}
      className={cn(
        "inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-4xl px-2 text-xs font-medium whitespace-nowrap [&>svg]:size-3 [&>svg]:shrink-0",
        toneClassName,
        className,
      )}
      {...props}
    >
      {icon ?? <ToneIcon aria-hidden="true" />}
      {children}
    </span>
  );
}
