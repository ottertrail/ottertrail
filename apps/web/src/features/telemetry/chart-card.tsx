import * as React from "react";

import { ReportChart } from "@/components/report-chart";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MISSING } from "@/lib/missing";

import { bucketLabel, stepText } from "./chart-time";
import { type ChartLine, TimeChart } from "./time-chart";

/** The time buckets a chart is drawn over, as the API gives them. */
export interface ChartFrame {
  /** The first bucket's start, ISO. */
  start: string;
  stepSeconds: number;
  buckets: number;
  timeZone: string;
  /**
   * Each bucket's start, ISO, when the buckets follow a clock with daylight
   * saving changes (the AI page's chart, as the lists' charts).
   */
  starts?: string[] | undefined;
}

/** What a chart over time buckets is given, in a card or in a report. */
interface ChartProps {
  title: string;
  description: React.ReactNode;
  frame: ChartFrame;
  lines: ChartLine[];
  formatValue: (value: number) => string;
  /** Why this chart cannot be drawn, shown in its place. */
  missing?: string | undefined;
  /** What the chart is of, after its title in the chart's accessible name, such as the metric. */
  subject: string;
  /** A fixed y-axis range, such as 0 to 100 for percentages. */
  domain?: { min: number; max: number } | undefined;
}

/** Every bucket with a value, as a table: the chart's numbers. */
function ChartTable({ title, frame, lines, formatValue }: ChartProps) {
  const startMs = Date.parse(frame.start);
  const rows = Array.from({ length: frame.buckets }, (_, index) => index).filter((index) =>
    lines.some((line) => line.values[index] !== null && line.values[index] !== undefined),
  );
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">{title}</caption>
      <thead className="sticky top-0 bg-[var(--block-surface,var(--background))]">
        <tr className="text-xs text-ink-subtle">
          <th scope="col" className="pb-2 text-left font-normal">
            Time
          </th>
          {lines.map((line) => (
            <th key={line.key} scope="col" className="pb-2 pl-4 text-right font-normal">
              {line.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((index) => (
          <tr key={index} className="border-t border-hairline">
            <th scope="row" className="py-1.5 text-left font-normal whitespace-nowrap text-ink">
              {bucketLabel(
                new Date(
                  frame.starts?.[index] ?? new Date(startMs + index * frame.stepSeconds * 1000),
                ),
                frame.stepSeconds,
                frame.timeZone,
              )}
            </th>
            {lines.map((line) => {
              const value = line.values[index];
              return (
                <td key={line.key} className="py-1.5 pl-4 text-right text-ink tabular-nums">
                  {value === null || value === undefined ? MISSING : formatValue(value)}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Chart({ plotHeight, ...props }: ChartProps & { plotHeight?: number }) {
  const { title, frame, lines, formatValue, subject, domain } = props;
  return (
    <TimeChart
      start={frame.start}
      starts={frame.starts}
      stepSeconds={frame.stepSeconds}
      buckets={frame.buckets}
      timeZone={frame.timeZone}
      lines={lines}
      label={`${title}, ${subject}, per ${stepText(frame.stepSeconds)}`}
      formatValue={formatValue}
      domain={domain}
      plotHeight={plotHeight}
    />
  );
}

/**
 * One chart of a report (the Services, Databases, Hosts, and Metrics
 * pages): full width and short, without a card, with its numbers as a
 * table on demand ("Show the numbers").
 */
export function ChartSection({
  headingLevel = 3,
  actions,
  ...props
}: ChartProps & {
  headingLevel?: 2 | 3;
  /** Controls beside the title, such as a toggle for what the chart draws. */
  actions?: React.ReactNode;
}) {
  const { title, description, missing } = props;
  return (
    <ReportChart
      title={title}
      headingLevel={headingLevel}
      description={description}
      actions={actions}
      table={missing === undefined ? <ChartTable {...props} /> : undefined}
    >
      {missing === undefined ? (
        <Chart {...props} plotHeight={140} />
      ) : (
        <p className="py-8 text-center text-sm text-ink-subtle">{missing}</p>
      )}
    </ReportChart>
  );
}

/**
 * One chart in a card (an uptime check's page), with its numbers as a
 * table on demand ("Show the numbers").
 */
export function ChartCard(props: ChartProps) {
  const { title, description, missing } = props;
  const [showTable, setShowTable] = React.useState(false);
  const tableId = React.useId();
  return (
    <Card className="[--block-surface:var(--card)]">
      <CardHeader>
        <CardTitle>
          <h3>{title}</h3>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {missing === undefined ? (
          <>
            <Chart {...props} />
            <div>
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={showTable}
                aria-controls={tableId}
                onClick={() => setShowTable((shown) => !shown)}
              >
                {showTable ? "Hide the numbers" : "Show the numbers"}
              </Button>
            </div>
            <div id={tableId} hidden={!showTable} className="max-h-96 overflow-auto">
              {showTable && <ChartTable {...props} />}
            </div>
          </>
        ) : (
          <p className="py-10 text-center text-sm text-ink-subtle">{missing}</p>
        )}
      </CardContent>
    </Card>
  );
}
