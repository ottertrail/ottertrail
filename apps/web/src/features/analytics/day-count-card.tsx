import * as React from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { DayChart } from "./day-chart";
import { formatDay, formatWhole } from "./format";

/**
 * One count per day, such as an error's occurrences or an event's
 * occurrences: a line, and every day's number in a table on demand.
 */
export function DayCountCard({
  days,
  noun,
}: {
  days: { day: string; count: number }[];
  /** What is counted, capitalized: "Occurrences", "Events". */
  noun: string;
}) {
  const [showTable, setShowTable] = React.useState(false);
  const tableId = React.useId();
  const title = `${noun} per day`;
  const tooltipRows = (index: number) => [
    { label: noun, value: formatWhole(days[index]?.count ?? 0), plotted: true },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>{title}</h3>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {days.length < 2 ? (
          <p className="py-10 text-center text-sm text-ink-subtle">
            A trend needs at least two days. Choose a longer period to see one.
          </p>
        ) : (
          <DayChart
            points={days.map((day) => ({ day: day.day, value: day.count }))}
            label={title}
            tooltipRows={tooltipRows}
          />
        )}
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
        <div id={tableId} hidden={!showTable} className="max-h-80 overflow-y-auto">
          {showTable && (
            <table className="w-full text-sm">
              <caption className="sr-only">{title}</caption>
              <thead className="sticky top-0 bg-card">
                <tr className="text-xs text-ink-subtle">
                  <th scope="col" className="pb-2 text-left font-normal">
                    Day
                  </th>
                  <th scope="col" className="pb-2 text-right font-normal">
                    {noun}
                  </th>
                </tr>
              </thead>
              <tbody>
                {days.map((day) => (
                  <tr key={day.day} className="border-t border-hairline">
                    <th scope="row" className="py-1.5 text-left font-normal text-ink">
                      {formatDay(day.day, { weekday: true })}
                    </th>
                    <td className="py-1.5 text-right text-ink tabular-nums">
                      {formatWhole(day.count)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
