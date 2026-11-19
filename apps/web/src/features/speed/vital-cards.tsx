import { type Stat, StatStrip } from "@/components/stat-strip";
import type { MetricSummary, Speed, VitalName } from "@/lib/speed-api";
import { CORE_VITALS } from "@/lib/speed-api";

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
      <div aria-hidden="true" className="flex h-2 max-w-72 gap-0.5 overflow-hidden rounded-full">
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
      <ul aria-label="Share of page loads" className="flex flex-wrap gap-x-3 gap-y-1">
        {RATINGS.map((item) => (
          <li key={item.value} className="flex items-center gap-1.5 whitespace-nowrap">
            <RatingIcon rating={item.value} named={false} />
            <span>{item.label}</span>
            <span className="font-medium text-ink tabular-nums">{percents[item.value]}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "Largest Contentful Paint (LCP), p75": a vital's name, its abbreviation, and the percentile shown. */
const vitalLabel = (name: VitalName) => `${VITALS[name].name} (${VITALS[name].short}), p75`;

function ratingOf(name: VitalName, speed: Speed) {
  const summary = speed.metrics[name];
  return summary.p75 === null ? null : rate(name, summary.p75, speed.thresholds[name]);
}

/**
 * The Core Web Vitals in one strip: each p75, its rating in words (a badge
 * with an icon, never color alone), what it means, how the loads were
 * spread, and how many were measured.
 */
export function CoreVitals({ speed }: { speed: Speed }) {
  const stats: Stat[] = CORE_VITALS.map((name) => {
    const summary = speed.metrics[name];
    return {
      label: vitalLabel(name),
      value: formatVital(name, summary.p75),
      detail: (
        <>
          <span className="flex">
            <RatingBadge rating={ratingOf(name, speed)} />
          </span>
          <span>{VITALS[name].explanation}</span>
          <ShareBar summary={summary} />
          <span data-slot="stat-measured">
            Measured on {loadsText(summary.count)}.
            {name === "inp" && " INP only counts loads with an interaction."}
          </span>
        </>
      ),
    };
  });
  return (
    <StatStrip
      label="Core Web Vitals"
      stats={stats}
      className="max-sm:grid-cols-1 sm:grid-cols-3 max-sm:[&>div]:border-l-0 max-sm:[&>div]:pl-0"
    />
  );
}

const SECONDARY: VitalName[] = ["fcp", "ttfb"];

/** FCP and TTFB: not Core Web Vitals, but a slow first paint or server answer delays LCP too. */
export function SecondaryVitals({ speed }: { speed: Speed }) {
  const stats: Stat[] = SECONDARY.map((name) => ({
    label: vitalLabel(name),
    value: formatVital(name, speed.metrics[name].p75),
    detail: (
      <>
        <span className="flex">
          <RatingBadge rating={ratingOf(name, speed)} />
        </span>
        <span>
          {VITALS[name].explanation} p75 of {loadsText(speed.metrics[name].count)}.
        </span>
      </>
    ),
  }));
  return (
    <section aria-labelledby="speed-before-lcp" className="flex flex-col gap-3 border-t pt-5">
      <div className="flex flex-col gap-1">
        <h2 id="speed-before-lcp" className="text-sm font-medium text-ink">
          Measurements before LCP
        </h2>
        <p className="max-w-4xl text-xs text-pretty text-ink-subtle">
          These two measurements help explain LCP. The main content cannot appear before the server
          responds and the browser starts to display the page.
        </p>
      </div>
      <StatStrip
        label="Measurements before LCP"
        stats={stats}
        className="sm:grid-cols-2 lg:max-w-3xl"
      />
    </section>
  );
}
