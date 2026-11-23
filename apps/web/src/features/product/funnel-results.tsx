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

import { formatDayRange, formatWhole } from "../analytics/format";
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

export function FunnelResults({ funnel }: { funnel: Funnel }) {
  const first = funnel.steps[0]?.reached ?? 0;
  const last = funnel.steps.at(-1)?.reached ?? 0;
  const who = funnel.count === "users" ? "users" : "visitors";
  const Who = who === "users" ? "Users" : "Visitors";
  const stats: Stat[] = [
    { label: "Overall conversion", value: formatShare(last, first) },
    { label: `${Who} at step 1`, value: formatWhole(first) },
    { label: `${Who} at step ${funnel.steps.length}`, value: formatWhole(last) },
  ];
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
      <StatStrip label="Conversion" stats={stats} className="sm:grid-cols-3 lg:max-w-3xl" />
      <p className="text-xs text-ink-subtle">
        {first === 0
          ? `No ${who} did step 1 in this period.`
          : `${formatWhole(last)} of ${formatWhole(first)} ${who} who did step 1 went on to step ${funnel.steps.length}.`}
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
              const before = index === 0 ? undefined : funnel.steps[index - 1];
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
                    {formatWhole(item.reached)}
                  </TableCell>
                  <TableCell className="py-2 text-right align-top text-ink tabular-nums">
                    {formatShare(item.reached, first)}
                  </TableCell>
                  <TableCell className="py-2 pr-0 text-right align-top text-ink-subtle tabular-nums">
                    {before === undefined ? MISSING : formatShare(item.reached, before.reached)}
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
