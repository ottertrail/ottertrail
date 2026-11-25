import { ChangedValue } from "@/components/changed-value";
import { PINNED } from "@/components/pinned-column";
import { ScrollHint } from "@/components/scroll-hint";
import { type Stat, StatStrip } from "@/components/stat-strip";
import { TruncatedText } from "@/components/truncated-text";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { MISSING } from "@/lib/missing";
import type { Funnel, FunnelStep } from "@/lib/product-api";

import {
  formatDay,
  formatDayRange,
  formatTimeOfDay,
  formatWhole,
  pointsChange,
  relativeChange,
} from "../analytics/format";
import { MIN_LOADS_FOR_CHANGE } from "../overview/format";
import { formatShare, windowLabel } from "./format";
import { stepText } from "./funnel-steps";

function StepName({ step }: { step: FunnelStep }) {
  return (
    <TruncatedText text={`${step.type === "page" ? "Page " : "Event "}${stepText(step)}`}>
      <span className="text-ink-subtle">{step.type === "page" ? "Page " : "Event "}</span>
      <span className="font-mono text-ink">{stepText(step)}</span>
    </TruncatedText>
  );
}

/** Which period the changes compare with, worded as the Web analytics summary words it. */
function comparisonNote({ previous, timeZone }: Funnel, who: string): string | null {
  if (previous === undefined) return null;
  const days = formatDayRange(previous.firstDay, previous.lastDay);
  if ((previous.reached[0] ?? 0) === 0) return `No ${who} did step 1 in ${days} to compare with.`;
  if (previous.until === null) return `Changes compare with ${days}.`;
  const time = formatTimeOfDay(previous.until, timeZone);
  return previous.firstDay === previous.lastDay
    ? `Changes compare with ${days}, up to ${time}.`
    : `Changes compare with ${days}, up to ${time} on ${formatDay(previous.lastDay)}.`;
}

const share = (part: number, whole: number) => (whole === 0 ? null : part / whole);

/** A count's change from the period before, when there is one to compare with. */
function countChange(current: number, previous: number | undefined): Partial<Stat> {
  if (previous === undefined) return {};
  return {
    change: relativeChange(current, previous),
    before: formatWhole(previous),
    counts: { current, previous },
  };
}

/**
 * Changes from the period before follow the Web analytics summary: counts
 * in percent, the conversion in percentage points, and none when fewer than
 * MIN_LOADS_FOR_CHANGE people are counted (lib/change.ts).
 */
export function FunnelResults({ funnel }: { funnel: Funnel }) {
  const first = funnel.steps[0]?.reached ?? 0;
  const last = funnel.steps.at(-1)?.reached ?? 0;
  const before = funnel.previous?.reached;
  const beforeFirst = before?.[0];
  const beforeLast = before?.at(-1);
  const who = funnel.count === "users" ? "users" : "visitors";
  const Who = who === "users" ? "Users" : "Visitors";
  const stats: Stat[] = [
    {
      label: "Overall conversion",
      value: formatShare(last, first),
      ...(beforeFirst === undefined || beforeLast === undefined
        ? {}
        : {
            // A share changes in percentage points.
            change: pointsChange(share(last, first), share(beforeLast, beforeFirst)),
            before: formatShare(beforeLast, beforeFirst),
            counts: { current: first, previous: beforeFirst },
          }),
    },
    { label: `${Who} at step 1`, value: formatWhole(first), ...countChange(first, beforeFirst) },
    {
      label: `${Who} at step ${funnel.steps.length}`,
      value: formatWhole(last),
      ...countChange(last, beforeLast),
    },
  ];
  const note = comparisonNote(funnel, who);
  return (
    <section aria-labelledby="funnel-conversion" className="flex flex-col gap-4 border-t pt-5">
      <div className="flex flex-col gap-1">
        <h2 id="funnel-conversion" className="text-sm font-medium text-ink">
          Conversion
        </h2>
        <p className="text-xs text-ink-subtle">
          {formatDayRange(funnel.firstDay, funnel.lastDay)}, counted by {who}, within{" "}
          {windowLabel(funnel.window)} of step 1
        </p>
      </div>
      <StatStrip
        label="Conversion"
        stats={stats}
        minCount={MIN_LOADS_FOR_CHANGE}
        className="sm:grid-cols-3 lg:max-w-3xl"
      />
      <p className="max-w-4xl text-xs text-pretty text-ink-subtle">
        <span>
          {first === 0
            ? `No ${who} did step 1 in this period.`
            : `${formatWhole(last)} of ${formatWhole(first)} ${who} who did step 1 went on to step ${funnel.steps.length}.`}
        </span>
        {note !== null && <span> {note}</span>}
      </p>
      <ScrollHint>
        <Table className="table-fixed max-sm:min-w-[30rem] lg:max-w-5xl">
          <caption className="sr-only">Funnel steps, with the {who} who reached each</caption>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead
                scope="col"
                className={`h-8 pl-0 text-xs font-normal text-ink-subtle ${PINNED}`}
              >
                Step
              </TableHead>
              <TableHead
                scope="col"
                className="h-8 w-24 text-right text-xs font-normal text-ink-subtle"
              >
                {Who}
              </TableHead>
              <TableHead
                scope="col"
                className="h-8 w-24 text-right text-xs font-normal text-ink-subtle"
              >
                Of step 1
              </TableHead>
              <TableHead
                scope="col"
                className="h-8 w-32 pr-0 text-right text-xs font-normal text-ink-subtle"
              >
                Of the step before
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {funnel.steps.map((item, index) => {
              const stepBefore = index === 0 ? undefined : funnel.steps[index - 1];
              const then = before?.[index];
              return (
                <TableRow key={index} className="hover:bg-transparent">
                  <th
                    scope="row"
                    className={`py-2 pr-3 pl-0 text-left align-top font-normal ${PINNED}`}
                  >
                    <div className="flex gap-2">
                      <span className="text-ink-subtle tabular-nums">{index + 1}.</span>
                      <StepName step={item.step} />
                    </div>
                    <div aria-hidden="true" className="mt-1.5 h-1.5 rounded-r bg-hairline">
                      <div
                        className="h-1.5 rounded-r bg-chart-1"
                        style={{ width: `${first === 0 ? 0 : (item.reached / first) * 100}%` }}
                      />
                    </div>
                  </th>
                  <TableCell className="py-2 text-right align-top text-ink tabular-nums">
                    {then === undefined ? (
                      formatWhole(item.reached)
                    ) : (
                      <ChangedValue
                        value={formatWhole(item.reached)}
                        change={relativeChange(item.reached, then)}
                        counts={{ current: item.reached, previous: then }}
                        min={MIN_LOADS_FOR_CHANGE}
                        before={formatWhole(then)}
                      />
                    )}
                  </TableCell>
                  <TableCell className="py-2 text-right align-top text-ink tabular-nums">
                    {formatShare(item.reached, first)}
                  </TableCell>
                  <TableCell className="py-2 pr-0 text-right align-top text-ink-subtle tabular-nums">
                    {stepBefore === undefined
                      ? MISSING
                      : formatShare(item.reached, stepBefore.reached)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </ScrollHint>
    </section>
  );
}
