import * as React from "react";

import { ReportChart } from "@/components/report-chart";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MISSING } from "@/lib/missing";

import { bucketLabel, stepText } from "./chart-time";
import { type ChartLine, TimeChart } from "./time-chart";

export interface ChartFrame {
  start: string;
  stepSeconds: number;
  buckets: number;
  timeZone: string;
  /** Use explicit ISO starts across daylight saving changes. */
  starts?: string[] | undefined;
}

interface ChartProps {
  title: string;
  description: React.ReactNode;
  frame: ChartFrame;
  lines: ChartLine[];
  formatValue: (value: number) => string;
  missing?: string | undefined;
  subject: string;
  domain?: { min: number; max: number } | undefined;
}

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

export function ChartSection({
  headingLevel = 3,
  actions,
  ...props
}: ChartProps & {
  headingLevel?: 2 | 3;
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
