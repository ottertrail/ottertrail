import { useQuery } from "@tanstack/react-query";

import { PINNED } from "@/components/pinned-column";
import { ScrollHint } from "@/components/scroll-hint";
import { TruncatedText } from "@/components/truncated-text";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { PageRange } from "@/lib/analytics-api";
import {
  BREAKDOWN_COLUMNS,
  BREAKDOWN_PROPERTY_PREFIX,
  type FunnelBreakdownBy,
  type FunnelBreakdownRow,
  type FunnelCount,
  type FunnelStep,
  type FunnelWindow,
  funnelBreakdownQuery,
  isBreakdownBy,
  productEventQuery,
} from "@/lib/product-api";

import { formatWhole } from "../analytics/format";
import { valueText } from "../analytics/list-rows";
import { ChoiceFilter } from "../telemetry/filters";
import { formatShare } from "./format";
import { LoadFailed, Refreshing } from "./report-state";

const propertyOf = (by: FunnelBreakdownBy) =>
  by.startsWith(BREAKDOWN_PROPERTY_PREFIX) ? by.slice(BREAKDOWN_PROPERTY_PREFIX.length) : null;

/** "Device", or "plan" for a property. */
function byLabel(by: FunnelBreakdownBy): string {
  return propertyOf(by) ?? BREAKDOWN_COLUMNS.find((item) => item.value === by)?.label ?? by;
}

/** "By device", or "By plan" for a property. */
function byChoice(by: FunnelBreakdownBy): string {
  const property = propertyOf(by);
  return `By ${property ?? byLabel(by).toLowerCase()}`;
}

/** A row's name: a value as the Web analytics page writes it, Other, or Unknown. */
function rowText(row: FunnelBreakdownRow, by: FunnelBreakdownBy): string {
  if (row.kind === "other") return "Other";
  if (row.kind === "unknown" || row.value === null) return "Unknown";
  const column = BREAKDOWN_COLUMNS.find((item) => item.value === by)?.value;
  return column === undefined ? row.value : valueText(column, row.value);
}

/**
 * "Break down by" and, once chosen, the funnel per value: the top 5 by
 * step 1, then Other and Unknown, each with its people at every step and
 * its overall conversion, as a bar and in numbers.
 */
export function FunnelBreakdownSection({
  projectId,
  range,
  environment,
  steps,
  count,
  window,
  by,
  onBy,
}: {
  projectId: string;
  range: PageRange;
  environment: string;
  steps: FunnelStep[];
  count: FunnelCount;
  window: FunnelWindow;
  by: FunnelBreakdownBy | undefined;
  onBy: (by: FunnelBreakdownBy | undefined) => void;
}) {
  const first = steps[0];
  // Step 1's properties, as its event's page lists them (the 30 most frequent).
  const event = useQuery({
    ...productEventQuery(
      projectId,
      first?.type === "event" ? first.name : "",
      range,
      environment,
      [],
    ),
    enabled: first?.type === "event",
  });
  const properties = first?.type === "event" ? (event.data?.properties ?? []) : [];
  const breakdown = useQuery({
    ...funnelBreakdownQuery(
      projectId,
      range,
      environment,
      steps,
      count,
      window,
      by ?? "deviceType",
    ),
    enabled: by !== undefined,
  });
  const who = count === "users" ? "users" : "visitors";
  const choices: FunnelBreakdownBy[] = [
    ...BREAKDOWN_COLUMNS.map((item) => item.value),
    ...properties.map((item) => `${BREAKDOWN_PROPERTY_PREFIX}${item.key}` as const),
  ];
  // A property from the address that the event's list does not hold is still a choice.
  if (by !== undefined && !choices.includes(by)) choices.push(by);
  const data = by === undefined ? undefined : breakdown.data;

  return (
    <section aria-labelledby="funnel-breakdown" className="flex flex-col gap-4 border-t pt-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="funnel-breakdown" className="text-sm font-medium text-ink">
          {by === undefined ? "Breakdown" : byChoice(by)}
        </h2>
        <ChoiceFilter
          label="Break down by"
          anyLabel="No breakdown"
          choices={choices.map((value) => ({ value, label: byChoice(value) }))}
          value={by}
          onChange={(next) => onBy(isBreakdownBy(next) ? next : undefined)}
          className="w-56"
        />
      </div>
      {by !== undefined && breakdown.isError && (
        <LoadFailed
          what="The breakdown"
          message={breakdown.error.message}
          hasData={data !== undefined}
          onRetry={() => void breakdown.refetch()}
        />
      )}
      {by !== undefined &&
        (data === undefined ? (
          !breakdown.isError && <Skeleton className="h-40 w-full" aria-label="Loading" />
        ) : (
          <Refreshing stale={breakdown.isPlaceholderData}>
            <BreakdownTable rows={data.rows} by={by} steps={steps} who={who} />
          </Refreshing>
        ))}
    </section>
  );
}

function BreakdownTable({
  rows,
  by,
  steps,
  who,
}: {
  rows: FunnelBreakdownRow[];
  by: FunnelBreakdownBy;
  steps: FunnelStep[];
  who: string;
}) {
  const label = byLabel(by);
  const property = propertyOf(by) !== null;
  if (rows.length === 0) {
    return <p className="text-sm text-ink-subtle">No {who} did step 1 in this period.</p>;
  }
  return (
    <ScrollHint>
      <Table className="table-fixed max-sm:min-w-[36rem] lg:max-w-5xl">
        <caption className="sr-only">
          {`Funnel steps ${byChoice(by).replace(/^By /, "by ")}, with the ${who} who reached each`}
        </caption>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead
              scope="col"
              className={`h-8 pl-0 text-xs font-normal text-ink-subtle ${PINNED}`}
            >
              {label}
            </TableHead>
            {steps.map((_, index) => (
              <TableHead
                key={index}
                scope="col"
                className="h-8 w-20 text-right text-xs font-normal text-ink-subtle"
              >
                Step {index + 1}
              </TableHead>
            ))}
            <TableHead
              scope="col"
              className="h-8 w-24 pr-0 text-right text-xs font-normal text-ink-subtle"
            >
              Conversion
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const start = row.reached[0] ?? 0;
            const end = row.reached.at(-1) ?? 0;
            const text = rowText(row, by);
            return (
              <TableRow key={`${row.kind}:${row.value ?? ""}`} className="hover:bg-transparent">
                <th
                  scope="row"
                  className={`py-2 pr-3 pl-0 text-left align-top font-normal ${PINNED}`}
                >
                  <TruncatedText
                    text={text}
                    className={
                      row.kind === "value"
                        ? `text-ink ${property ? "font-mono" : ""}`
                        : "text-ink-subtle"
                    }
                  />
                  <div aria-hidden="true" className="mt-1.5 h-1.5 rounded-r bg-hairline">
                    <div
                      className={`h-1.5 rounded-r ${row.kind === "value" ? "bg-chart-1" : "bg-ink-tertiary"}`}
                      style={{ width: `${start === 0 ? 0 : (end / start) * 100}%` }}
                    />
                  </div>
                </th>
                {steps.map((_, index) => (
                  <TableCell
                    key={index}
                    className="py-2 text-right align-top text-ink tabular-nums"
                  >
                    {formatWhole(row.reached[index] ?? 0)}
                  </TableCell>
                ))}
                <TableCell className="py-2 pr-0 text-right align-top text-ink tabular-nums">
                  {formatShare(end, start)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </ScrollHint>
  );
}
