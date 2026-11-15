import { LoaderCircleIcon, RefreshCwIcon } from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useApiHealth } from "@/hooks/use-api-health";

/**
 * Live result of GET /api/health. Shows the real state, including failures.
 * The <output> element is a polite live region, so changes are announced.
 */
export function ApiStatus() {
  const { health, retry } = useApiHealth();

  return (
    <output aria-label="API status" className="flex items-center gap-1">
      {health.state === "checking" && (
        <StatusBadge
          tone="neutral"
          icon={<LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
        >
          Checking API
        </StatusBadge>
      )}
      {health.state === "ok" && <StatusBadge tone="good">API online</StatusBadge>}
      {health.state === "unreachable" && (
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
