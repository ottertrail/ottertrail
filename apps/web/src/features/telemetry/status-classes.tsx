import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { STATUS_CLASSES, type StatusCounts } from "@/lib/services-api";

import { formatConversion, formatWhole } from "../analytics/format";
import { STATUS_COLORS, STATUS_LABELS, statusText } from "./status-format";

/** The classes' names and colors, once above the bars that use them. */
export function StatusLegend() {
  return (
    <ul
      aria-label="Status classes"
      className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted"
    >
      {STATUS_CLASSES.map((name) => (
        <li key={name} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full"
            style={{ background: STATUS_COLORS[name] }}
          />
          {STATUS_LABELS[name]}
        </li>
      ))}
    </ul>
  );
}

/**
 * A thin segmented bar of one whole, the requests, split by class: widths
 * in proportion, a 2px gap between parts, rounded ends, no text. Hover and
 * keyboard focus show every class's count and share; its accessible name
 * says the same.
 */
export function StatusBar({
  statuses,
  label,
  className,
}: {
  statuses: StatusCounts;
  /** What the requests are, such as the route: the start of the accessible name. */
  label: string;
  className?: string;
}) {
  const total = STATUS_CLASSES.reduce((sum, name) => sum + statuses[name], 0);
  const parts = STATUS_CLASSES.filter((name) => statuses[name] > 0);
  const text = `${label}: ${statusText(statuses)}`;
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={text}
        // It only shows a tooltip: in a clickable row (a service's routes), a click on it is the row's.
        data-row-passthrough=""
        className={`flex h-2 w-full min-w-16 cursor-default gap-0.5 rounded-full outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring ${className ?? ""}`}
      >
        {total === 0 ? (
          <span className="h-full w-full rounded-full bg-muted" />
        ) : (
          parts.map((name) => (
            <span
              key={name}
              data-status={name}
              className="h-full min-w-0.5 rounded-full"
              style={{ flexGrow: statuses[name], flexBasis: 0, background: STATUS_COLORS[name] }}
            />
          ))
        )}
      </TooltipTrigger>
      <TooltipContent>
        <ul className="flex flex-col gap-1">
          {parts.map((name) => (
            <li key={name} className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-full"
                style={{ background: STATUS_COLORS[name] }}
              />
              <span className="font-semibold tabular-nums">{formatWhole(statuses[name])}</span>
              <span>
                {STATUS_LABELS[name]} ({formatConversion(statuses[name] / total)})
              </span>
            </li>
          ))}
          {parts.length === 0 && <li>No requests</li>}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}
