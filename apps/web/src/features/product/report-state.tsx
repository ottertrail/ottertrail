import { OctagonAlertIcon } from "lucide-react";
import type * as React from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * A report that failed to load or refresh, with a retry. After a refresh
 * fails, the report below is the last one that loaded, and says so.
 */
export function LoadFailed({
  what,
  message,
  hasData,
  onRetry,
}: {
  /** "The events", "The funnel" … */
  what: string;
  message: string;
  hasData: boolean;
  onRetry: () => void;
}) {
  return (
    <Alert variant="destructive">
      <OctagonAlertIcon />
      <AlertTitle>{hasData ? `${what} could not refresh` : `${what} could not load`}</AlertTitle>
      <AlertDescription>
        {message}
        {hasData && " The report below is from the last successful load."}
      </AlertDescription>
      <AlertAction>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </AlertAction>
    </Alert>
  );
}

/** Skeleton rows shaped like a table or list. */
export function LoadingRows({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={className ?? "flex flex-col gap-2"} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-10 w-full" />
      ))}
    </div>
  );
}

/** The report, dimmed while another period or setting loads in its place. */
export function Refreshing({ stale, children }: { stale: boolean; children: React.ReactNode }) {
  return (
    <div
      className="flex flex-col gap-4 transition-opacity data-[stale=true]:opacity-60"
      data-stale={stale}
      aria-busy={stale}
    >
      {children}
    </div>
  );
}
