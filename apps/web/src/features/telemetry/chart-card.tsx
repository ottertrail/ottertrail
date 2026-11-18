import * as React from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { bucketLabel, stepText } from "./chart-time";
import { type ChartLine, TimeChart } from "./time-chart";

/** The time buckets a chart is drawn over, as the API gives them. */
export interface ChartFrame {
  /** The first bucket's start, ISO. */
  start: string;
  stepSeconds: number;
  buckets: number;
  timeZone: string;
}

/**
 * One chart in a card (the Metrics and Hosts pages), with its numbers as a
 * table on demand ("Show the numbers").
 */
export function ChartCard({
  title,
  description,
  frame,
  lines,
  formatValue,
  missing,
  subject,
  domain,
}: {
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
}) {
  const [showTable, setShowTable] = React.useState(false);
  const tableId = React.useId();
  const startMs = Date.parse(frame.start);
  const rows = Array.from({ length: frame.buckets }, (_, index) => index).filter((index) =>
    lines.some((line) => line.values[index] !== null && line.values[index] !== undefined),
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>{title}</h3>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {missing === undefined ? (
          <>
            <TimeChart
              start={frame.start}
              stepSeconds={frame.stepSeconds}
              buckets={frame.buckets}
              timeZone={frame.timeZone}
              lines={lines}
              label={`${title}, ${subject}, per ${stepText(frame.stepSeconds)}`}
              formatValue={formatValue}
              domain={domain}
            />
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
              {showTable && (
                <table className="w-full text-sm">
                  <caption className="sr-only">{title}</caption>
                  <thead className="sticky top-0 bg-card">
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
                        <th
                          scope="row"
                          className="py-1.5 text-left font-normal whitespace-nowrap text-ink"
                        >
                          {bucketLabel(
                            new Date(startMs + index * frame.stepSeconds * 1000),
                            frame.stepSeconds,
                            frame.timeZone,
                          )}
                        </th>
                        {lines.map((line) => {
                          const value = line.values[index];
                          return (
                            <td
                              key={line.key}
                              className="py-1.5 pl-4 text-right text-ink tabular-nums"
                            >
                              {value === null || value === undefined ? "–" : formatValue(value)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        ) : (
          <p className="py-10 text-center text-sm text-ink-subtle">{missing}</p>
        )}
      </CardContent>
    </Card>
  );
}
