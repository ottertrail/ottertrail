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
 * The status as a dot, for the sidebar collapsed to icons: the same words
 * for screen readers, and in a tooltip on hover and focus, with the
 * reason when the API cannot be reached. Retry waits for the expanded
 * sidebar.
 */
function StatusDot({ health }: { health: ApiHealthState }) {
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
      <TooltipContent side="right">
        {health.state === "unreachable" ? `${label}: ${health.reason}` : label}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Live result of GET /api/health. Shows the real state, including failures.
 * The <output> element is a polite live region, so changes are announced.
 * `compact` draws it as a dot (the collapsed sidebar).
 */
export function ApiStatus({
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  const { health, retry } = useApiHealth();

  return (
    <output aria-label="API status" className={cn("flex items-center gap-1", className)}>
      {compact && <StatusDot health={health} />}
      {!compact && health.state === "checking" && (
        <StatusBadge
          tone="neutral"
          icon={<LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
        >
          Checking API
        </StatusBadge>
      )}
      {!compact && health.state === "ok" && <StatusBadge tone="good">API online</StatusBadge>}
      {!compact && health.state === "unreachable" && (
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
