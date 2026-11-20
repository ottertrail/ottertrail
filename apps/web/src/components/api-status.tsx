import { cn } from "cn";
import { LoaderCircleIcon, RefreshCwIcon } from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type ApiHealthState, useApiHealth } from "@/hooks/use-api-health";

const DOT_TONE = {
  checking: "bg-ink-subtle",
  ok: "bg-status-good",
  unreachable: "bg-status-critical",
} as const;

const LABEL = { checking: "Checking API", ok: "API online", unreachable: "API unreachable" };

/**
 * The status as a dot: in the sidebar's head while the API is online, and
 * on the mark's corner when the sidebar is collapsed to icons. The same
 * words for screen readers, and in a tooltip on hover and focus, with the
 * reason when the API cannot be reached. Retry waits for the expanded
 * sidebar.
 */
function StatusDot({ health, side }: { health: ApiHealthState; side: "right" | "bottom" }) {
  const label = LABEL[health.state];
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span />}
        tabIndex={0}
        data-slot="api-status-dot"
        data-state={health.state}
        className="flex size-3 items-center justify-center rounded-full bg-sidebar outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span aria-hidden="true" className={cn("size-2 rounded-full", DOT_TONE[health.state])} />
        <span className="sr-only">{label}</span>
      </TooltipTrigger>
      <TooltipContent side={side}>
        {health.state === "unreachable" ? `${label}: ${health.reason}` : label}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Live result of GET /api/health. Shows the real state, including failures.
 * The <output> element is a polite live region, so changes are announced.
 * `compact` draws it as a dot (the collapsed sidebar); `quiet` draws a dot
 * while the API is online or being checked, and the full badge, with its
 * reason and Retry, only when it cannot be reached (the sidebar's head).
 * `badgeClassName` applies while the badge shows.
 */
export function ApiStatus({
  compact = false,
  quiet = false,
  className,
  badgeClassName,
}: {
  compact?: boolean;
  quiet?: boolean;
  className?: string;
  badgeClassName?: string;
}) {
  const { health, retry } = useApiHealth();
  const dot = compact || (quiet && health.state !== "unreachable");

  return (
    <output
      aria-label="API status"
      data-state={health.state}
      className={cn("flex items-center gap-1", className, !dot && badgeClassName)}
    >
      {dot && <StatusDot health={health} side={compact ? "right" : "bottom"} />}
      {!dot && health.state === "checking" && (
        <StatusBadge
          tone="neutral"
          icon={<LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
        >
          Checking API
        </StatusBadge>
      )}
      {!dot && health.state === "ok" && <StatusBadge tone="good">API online</StatusBadge>}
      {!dot && health.state === "unreachable" && (
        <>
          <Tooltip>
            <TooltipTrigger render={<StatusBadge tone="critical" tabIndex={0} />}>
              API unreachable
            </TooltipTrigger>
            <TooltipContent>{health.reason}</TooltipContent>
          </Tooltip>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={retry}
            aria-label="Retry API health check"
          >
            <RefreshCwIcon />
          </Button>
        </>
      )}
    </output>
  );
}
