import * as React from "react";
import { enGB } from "react-day-picker/locale";

import { Calendar } from "@/components/ui/calendar";

/**
 * One day on shadcn's calendar, for `DateField`'s popover: weeks start on
 * Monday (enGB, as the custom range dialog's), today underlined, and days
 * after `max` disabled. A module of its own so the calendar's code loads
 * only when a date field first opens it.
 */
export function DayCalendar({
  selected,
  month,
  onMonthChange,
  onSelect,
  max,
}: {
  selected: Date | undefined;
  month: Date;
  onMonthChange: (month: Date) => void;
  onSelect: (date: Date | undefined) => void;
  /** The last day that can be picked. */
  max: Date | undefined;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  // As it opens, focus goes to the chosen day, else today, else the first day
  // that can be picked, so the arrow keys move from there.
  React.useEffect(() => {
    const days = ref.current;
    if (days === null) return;
    const day =
      days.querySelector<HTMLElement>('button[data-selected-single="true"]') ??
      days.querySelector<HTMLElement>("[data-today] button:not([disabled])") ??
      days.querySelector<HTMLElement>("button[data-day]:not([disabled])");
    day?.focus();
  }, []);
  return (
    <div ref={ref}>
      <Calendar
        mode="single"
        locale={enGB}
        selected={selected}
        onSelect={onSelect}
        month={month}
        onMonthChange={onMonthChange}
        disabled={max === undefined ? undefined : { after: max }}
        className="[--cell-size:--spacing(9)]"
        classNames={{
          today:
            "[&_button]:font-semibold [&_button]:underline [&_button]:decoration-2 [&_button]:underline-offset-4",
        }}
      />
    </div>
  );
}
