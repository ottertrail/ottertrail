import { cn } from "cn";
import { CalendarIcon } from "lucide-react";
import * as React from "react";

import { DayInput } from "@/components/day-input";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { dateOf, dayFromText, dayOf, dayText } from "@/features/analytics/day-text";
import { loadChunk, PageLoadError } from "@/lib/lazy-page";
import { reloadPage } from "@/lib/reload";

/** In the calendar's place when its code could not be downloaded (a tab left open across a deploy). */
function CalendarUnavailable() {
  return (
    <div className="flex w-64 flex-col items-start gap-3 p-3 text-sm">
      <p className="text-pretty text-ink-muted">
        The calendar could not load. Type the day, or reload to try again.
      </p>
      <Button size="sm" variant="outline" onClick={reloadPage}>
        Reload
      </Button>
    </div>
  );
}

/** shadcn's calendar, loaded when a date field first opens it: it is large. */
const DayCalendar = React.lazy(async () => {
  try {
    const loaded = await loadChunk(() => import("./day-calendar"));
    return { default: loaded.DayCalendar };
  } catch (error) {
    if (error instanceof PageLoadError) return { default: CalendarUnavailable };
    throw error;
  }
});

/**
 * Use the styled calendar instead of the native picker (docs/design-system.md, "Fields").
 * Display DD/MM/YYYY; exchange YYYY-MM-DD, or "" for incomplete or invalid dates.
 * Keep typed text until an external value change.
 */
export function DateField({
  id,
  label,
  value,
  onChange,
  max,
  invalid = false,
  describedBy,
  className,
}: {
  id: string;
  /** The field's label, for the calendar button's name. */
  label: string;
  value: string;
  onChange: (day: string) => void;
  /** The last day ("YYYY-MM-DD") the calendar offers. */
  max?: string | undefined;
  invalid?: boolean;
  describedBy?: string | undefined;
  className?: string;
}) {
  const [text, setText] = React.useState(() => dayText(value));
  // A new value from outside (a reset, a discard) shows; one this field sent keeps its text.
  const [shown, setShown] = React.useState(value);
  if (value !== shown) {
    setShown(value);
    if (value !== (dayFromText(text) ?? "")) setText(dayText(value));
  }
  const [open, setOpen] = React.useState(false);
  const selected = dateOf(value);
  const [month, setMonth] = React.useState<Date>(() => selected ?? new Date());
  const send = (day: string) => {
    setShown(day);
    onChange(day);
  };

  return (
    <div className={cn("relative", className)}>
      <DayInput
        id={id}
        text={text}
        onTextChange={(next) => {
          setText(next);
          const day = dayFromText(next);
          if (day !== null) setMonth(dateOf(day) ?? month);
          send(day ?? "");
        }}
        invalid={invalid}
        aria-describedby={describedBy}
        className="pe-10"
      />
      <Popover
        open={open}
        onOpenChange={(next) => {
          // Opening shows the chosen day's month, or today's.
          if (next) setMonth(dateOf(value) ?? new Date());
          setOpen(next);
        }}
      >
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`${label}: open the calendar`}
              className="absolute end-1 top-1/2 -translate-y-1/2 text-ink-subtle"
            />
          }
        >
          <CalendarIcon aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-auto p-0">
          <React.Suspense fallback={<div className="h-80 w-72" aria-busy="true" />}>
            <DayCalendar
              selected={selected}
              month={month}
              onMonthChange={setMonth}
              max={max === undefined ? undefined : dateOf(max)}
              onSelect={(date) => {
                if (date === undefined) return;
                const day = dayOf(date);
                setText(dayText(day));
                send(day);
                setOpen(false);
              }}
            />
          </React.Suspense>
        </PopoverContent>
      </Popover>
    </div>
  );
}
