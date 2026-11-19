import { ReportChart } from "@/components/report-chart";
import { CORE_VITALS, type Speed } from "@/lib/speed-api";

import { DayChart } from "../analytics/day-chart";
import { formatDay, formatWhole } from "../analytics/format";
import { formatMs, formatVital, VITALS } from "./format";

/** Every day's loads and p75s, the chart's table view. */
function DayTable({ days }: { days: Speed["days"] }) {
  return (
    <table className="w-full max-w-2xl text-sm">
      <caption className="sr-only">Page loads and p75 per day</caption>
      <thead className="sticky top-0 bg-[var(--block-surface,var(--background))]">
        <tr className="text-xs text-ink-subtle">
          <th scope="col" className="pb-2 text-left font-normal">
            Day
          </th>
          <th scope="col" className="pb-2 text-right font-normal">
            Loads
          </th>
          {CORE_VITALS.map((name) => (
            <th key={name} scope="col" className="pb-2 text-right font-normal">
              {VITALS[name].short}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {days.map((day) => (
          <tr key={day.day} className="border-t border-hairline">
            <th scope="row" className="py-1.5 text-left font-normal text-ink">
              {formatDay(day.day, { weekday: true })}
            </th>
            <td className="py-1.5 text-right text-ink tabular-nums">{formatWhole(day.loads)}</td>
            {CORE_VITALS.map((name) => (
              <td key={name} className="py-1.5 text-right text-ink tabular-nums">
                {formatVital(name, day[name])}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The p75 of LCP per day, short and full width: a line with gaps on days
 * without a measured load, and every day's numbers in a table on demand.
 */
export function LcpDayCard({ days }: { days: Speed["days"] }) {
  const measured = days.some((day) => day.lcp !== null);
  const tooltipRows = (index: number) => {
    const day = days[index];
    return [
      { label: "LCP p75", value: formatVital("lcp", day?.lcp ?? null), plotted: true },
      { label: "INP p75", value: formatVital("inp", day?.inp ?? null), plotted: false },
      { label: "CLS p75", value: formatVital("cls", day?.cls ?? null), plotted: false },
      { label: "page loads", value: formatWhole(day?.loads ?? 0), plotted: false },
    ];
  };
  return (
    <ReportChart title="LCP per day (p75)" table={<DayTable days={days} />}>
      {days.length < 2 ? (
        <p className="py-8 text-center text-sm text-ink-subtle">
          A trend needs at least two days. Choose a longer period to see one.
        </p>
      ) : measured ? (
        <DayChart
          points={days.map((day) => ({ day: day.day, value: day.lcp }))}
          label="LCP per day, p75"
          tooltipRows={tooltipRows}
          formatValue={formatMs}
          plotHeight={140}
        />
      ) : (
        <p className="py-8 text-center text-sm text-ink-subtle">
          No page load in this period had an LCP value. LCP is missing if a page was hidden before
          its main content appeared.
        </p>
      )}
    </ReportChart>
  );
}
