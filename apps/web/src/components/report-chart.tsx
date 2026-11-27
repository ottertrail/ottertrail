import { cn } from "cn";
import * as React from "react";

import { Button } from "@/components/ui/button";

/** Render the numbers table only when expanded. */
export function ReportChart({
  title,
  headingLevel = 2,
  description,
  actions,
  table,
  children,
  className,
}: {
  title: React.ReactNode;
  headingLevel?: 2 | 3;
  /** What the chart draws, in a line under the title. */
  description?: React.ReactNode;
  /** Controls beside the title, before "Show the numbers", such as a metric toggle. */
  actions?: React.ReactNode;
  /** The chart's numbers; without it there is no "Show the numbers". */
  table?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const Heading = `h${headingLevel}` as const;
  const [showTable, setShowTable] = React.useState(false);
  const headingId = React.useId();
  const tableId = React.useId();
  return (
    <section
      aria-labelledby={headingId}
      data-slot="report-chart"
      className={cn("flex min-w-0 flex-col gap-2 border-t pt-5", className)}
    >
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <Heading id={headingId} className="text-sm font-medium text-ink">
          {title}
        </Heading>
        {(actions !== undefined || table !== undefined) && (
          <div className="flex flex-wrap items-center gap-2">
            {actions}
            {table !== undefined && (
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={showTable}
                aria-controls={tableId}
                onClick={() => setShowTable((shown) => !shown)}
              >
                {showTable ? "Hide the numbers" : "Show the numbers"}
              </Button>
            )}
          </div>
        )}
      </div>
      {description !== undefined && (
        <p className="max-w-4xl text-xs text-pretty text-ink-subtle">{description}</p>
      )}
      {children}
      {table !== undefined && (
        <div id={tableId} hidden={!showTable} className="max-h-80 overflow-auto">
          {showTable && table}
        </div>
      )}
    </section>
  );
}
