import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Funnel, FunnelStep } from "@/lib/product-api";

import { formatDayRange, formatWhole } from "../analytics/format";
import { formatShare, windowLabel } from "./format";
import { stepText } from "./funnel-steps";

function StepName({ step }: { step: FunnelStep }) {
  return (
    <span className="min-w-0 truncate" title={stepText(step)}>
      <span className="text-ink-subtle">{step.type === "page" ? "Page " : "Event "}</span>
      <span className="font-mono text-ink">{stepText(step)}</span>
    </span>
  );
}

/**
 * Each step's people as a bar from one baseline, sized against step 1,
 * with the numbers in text: reached, from step 1, and from the step
 * before.
 */
export function FunnelResults({ funnel }: { funnel: Funnel }) {
  const first = funnel.steps[0]?.reached ?? 0;
  const last = funnel.steps.at(-1)?.reached ?? 0;
  const who = funnel.count === "users" ? "users" : "visitors";
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>Conversion</h3>
        </CardTitle>
        <CardDescription>
          {formatDayRange(funnel.firstDay, funnel.lastDay)}, counted by {who}, within{" "}
          {windowLabel(funnel.window)} of step 1
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-3xl font-semibold tracking-tight text-ink tabular-nums">
            {formatShare(last, first)}
          </span>
          <span className="text-sm text-ink-subtle">
            {first === 0
              ? `No ${who} did step 1 in this period.`
              : `overall: ${formatWhole(last)} of ${formatWhole(first)} ${who} who did step 1 went on to step ${funnel.steps.length}.`}
          </span>
        </p>
        <table className="w-full table-fixed text-sm">
          <caption className="sr-only">Funnel steps, with the {who} who reached each</caption>
          <thead>
            <tr className="text-xs text-ink-subtle">
              <th scope="col" className="pb-2 text-left font-normal">
                Step
              </th>
              <th scope="col" className="w-24 pb-2 text-right font-normal">
                {who === "users" ? "Users" : "Visitors"}
              </th>
              <th scope="col" className="w-24 pb-2 text-right font-normal">
                Of step 1
              </th>
              <th scope="col" className="w-28 pb-2 text-right font-normal">
                Of the step before
              </th>
            </tr>
          </thead>
          <tbody>
            {funnel.steps.map((item, index) => {
              const before = index === 0 ? undefined : funnel.steps[index - 1];
              return (
                <tr key={index}>
                  <th scope="row" className="py-2 pr-3 text-left align-top font-normal">
                    <div className="flex gap-2">
                      <span className="text-ink-subtle tabular-nums">{index + 1}.</span>
                      <StepName step={item.step} />
                    </div>
                    <div aria-hidden="true" className="mt-1.5 h-2 rounded-r bg-hairline">
                      <div
                        className="h-2 rounded-r bg-chart-1"
                        style={{ width: `${first === 0 ? 0 : (item.reached / first) * 100}%` }}
                      />
                    </div>
                  </th>
                  <td className="py-2 text-right align-top text-ink tabular-nums">
                    {formatWhole(item.reached)}
                  </td>
                  <td className="py-2 text-right align-top text-ink tabular-nums">
                    {formatShare(item.reached, first)}
                  </td>
                  <td className="py-2 text-right align-top text-ink-subtle tabular-nums">
                    {before === undefined ? "–" : formatShare(item.reached, before.reached)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
