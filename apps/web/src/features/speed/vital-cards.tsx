import * as React from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { CoreVital, MetricSummary, Speed, VitalName } from "@/lib/speed-api";

import { formatWhole } from "../analytics/format";
import { formatVital, rate, RATINGS, shares, VITALS } from "./format";
import { RatingBadge, RatingIcon } from "./rating";

const BAR_COLORS = {
  good: "bg-status-good",
  needsImprovement: "bg-status-warning",
  poor: "bg-status-critical",
} as const;

const loadsText = (count: number) => `${formatWhole(count)} page ${count === 1 ? "load" : "loads"}`;

/**
 * The share of good, needs-improvement, and poor loads: a bar for the
 * glance, and the percentages as text beside each rating's icon.
 */
function ShareBar({ summary }: { summary: MetricSummary }) {
  const percents = shares(summary);
  if (percents === null) {
    return null;
  }
  return (
    <div className="flex flex-col gap-2">
      <div aria-hidden="true" className="flex h-2 gap-0.5 overflow-hidden rounded-full">
        {RATINGS.map((item) => {
          const part = summary[item.value];
          return part === 0 ? null : (
            <div
              key={item.value}
              className={BAR_COLORS[item.value]}
              style={{ flexGrow: part, flexBasis: 0 }}
            />
          );
        })}
      </div>
      <ul aria-label="Share of page loads" className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {RATINGS.map((item) => (
          <li key={item.value} className="flex items-center gap-1.5">
            <RatingIcon rating={item.value} named={false} />
            <span className="text-ink-subtle">{item.label}</span>
            <span className="font-medium text-ink tabular-nums">{percents[item.value]}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One Core Web Vital: its p75 and rating, what it means, and how the loads were spread. */
export function CoreVitalCard({ name, speed }: { name: CoreVital; speed: Speed }) {
  const titleId = React.useId();
  const vital = VITALS[name];
  const summary = speed.metrics[name];
  const rating = summary.p75 === null ? null : rate(name, summary.p75, speed.thresholds[name]);
  return (
    <article aria-labelledby={titleId} className="flex flex-col">
      <Card className="flex-1">
        <CardHeader>
          <CardTitle>
            <h3 id={titleId}>
              {vital.name} <span className="text-ink-subtle">({vital.short})</span>
            </h3>
          </CardTitle>
          <CardDescription>{vital.explanation}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <p className="flex items-baseline gap-1.5">
              <span className="text-3xl font-semibold tracking-tight text-ink tabular-nums">
                {formatVital(name, summary.p75)}
              </span>
              <span className="text-xs text-ink-subtle">p75</span>
            </p>
            <RatingBadge rating={rating} />
          </div>
          <ShareBar summary={summary} />
          <p className="mt-auto text-xs text-ink-subtle">
            Measured on {loadsText(summary.count)}.
            {name === "inp" && " INP only counts loads with an interaction."}
          </p>
        </CardContent>
      </Card>
    </article>
  );
}

const SECONDARY: VitalName[] = ["fcp", "ttfb"];

/** FCP and TTFB: not Core Web Vitals, but a slow first paint or server answer delays LCP too. */
export function SecondaryVitals({ speed }: { speed: Speed }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>What leads up to LCP</h3>
        </CardTitle>
        <CardDescription>
          These two help explain LCP: the main content cannot show before the server answers and the
          page starts to paint.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-4 sm:grid-cols-2">
          {SECONDARY.map((name) => {
            const vital = VITALS[name];
            const summary = speed.metrics[name];
            const rating =
              summary.p75 === null ? null : rate(name, summary.p75, speed.thresholds[name]);
            return (
              <div key={name} className="flex flex-col gap-1">
                <dt className="text-sm text-ink">
                  {vital.name} <span className="text-ink-subtle">({vital.short})</span>
                </dt>
                <dd className="flex flex-wrap items-center gap-2">
                  <span className="text-xl font-semibold tracking-tight text-ink tabular-nums">
                    {formatVital(name, summary.p75)}
                  </span>
                  <RatingBadge rating={rating} />
                </dd>
                <dd className="text-xs text-ink-subtle">
                  {vital.explanation} p75 of {loadsText(summary.count)}.
                </dd>
              </div>
            );
          })}
        </dl>
      </CardContent>
    </Card>
  );
}
