import * as React from "react";
import type { DateRange } from "react-day-picker";
import { enGB } from "react-day-picker/locale";

import { DayInput } from "@/components/day-input";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { MAX_RANGE_DAYS, rangeProblem } from "@/lib/analytics-api";

import { DAY_PLACEHOLDER, DAY_TEXT_LENGTH, dateOf, dayFromText, dayOf, dayText } from "./day-text";

/** Both dates are inclusive and use the timezone set in Settings. */
export function CustomRangeDialog({
  open,
  onOpenChange,
  from: initialFrom,
  to: initialTo,
  timeZone,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The days to start from, such as the page's current ones ("YYYY-MM-DD"). */
  from: string;
  to: string;
  timeZone: string | undefined;
  onApply: (from: string, to: string) => void;
}) {
  const [fromText, setFromText] = React.useState(dayText(initialFrom));
  const [toText, setToText] = React.useState(dayText(initialTo));
  // Validate after completion, blur, or submit.
  const [checked, setChecked] = React.useState({ from: false, to: false });
  const [month, setMonth] = React.useState(
    () => dateOf(initialTo) ?? dateOf(initialFrom) ?? new Date(),
  );
  const from = dayFromText(fromText);
  const to = dayFromText(toText);

  const problem =
    from === null
      ? fromText === ""
        ? "Enter the first day."
        : `Enter the first day as ${DAY_PLACEHOLDER}, a real day.`
      : to === null
        ? toText === ""
          ? "Enter the last day."
          : `Enter the last day as ${DAY_PLACEHOLDER}, a real day.`
        : rangeProblem(from, to);
  const fromShown = checked.from || fromText.length === DAY_TEXT_LENGTH;
  const toShown = checked.to || toText.length === DAY_TEXT_LENGTH;
  // Show range errors only after both fields have been checked.
  const shownProblem =
    problem === null
      ? null
      : from === null
        ? fromShown
          ? problem
          : null
        : to === null
          ? toShown
            ? problem
            : null
          : problem;
  const errorId = React.useId();
  const describedBy = shownProblem === null ? undefined : errorId;

  const typed = (field: "from" | "to", text: string) => {
    (field === "from" ? setFromText : setToText)(text);
    const date = dateOf(dayFromText(text) ?? "");
    if (date !== undefined) setMonth(date);
  };

  const picked = (range: DateRange | undefined) => {
    setFromText(range?.from === undefined ? "" : dayText(dayOf(range.from)));
    setToText(range?.to === undefined ? "" : dayText(dayOf(range.to)));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            setChecked({ from: true, to: true });
            if (problem === null && from !== null && to !== null) {
              onApply(from, to);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Custom range</DialogTitle>
            <DialogDescription>
              Whole days{timeZone === undefined ? "" : ` in ${timeZone}`}, both included, at most{" "}
              {MAX_RANGE_DAYS}. Pick the first and last day, or type them.
            </DialogDescription>
          </DialogHeader>
          <Calendar
            mode="range"
            // A click on a complete range starts a new range.
            resetOnSelect
            locale={enGB}
            selected={{ from: dateOf(from ?? ""), to: dateOf(to ?? "") }}
            onSelect={picked}
            month={month}
            onMonthChange={setMonth}
            className="mx-auto rounded-lg border bg-transparent [--cell-size:--spacing(9)]"
            classNames={{
              // Underline today; a fill would look like part of the range.
              today:
                "[&_button]:font-semibold [&_button]:underline [&_button]:decoration-2 [&_button]:underline-offset-4",
            }}
          />
          <FieldGroup className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="range-from">First day</FieldLabel>
              <DayInput
                id="range-from"
                text={fromText}
                onTextChange={(text) => typed("from", text)}
                onBlur={() => setChecked((state) => ({ ...state, from: true }))}
                invalid={shownProblem !== null && (from === null || to !== null)}
                aria-describedby={describedBy}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="range-to">Last day</FieldLabel>
              <DayInput
                id="range-to"
                text={toText}
                onTextChange={(text) => typed("to", text)}
                onBlur={() => setChecked((state) => ({ ...state, to: true }))}
                invalid={shownProblem !== null && from !== null}
                aria-describedby={describedBy}
                required
              />
            </Field>
          </FieldGroup>
          {shownProblem !== null && <FieldError id={errorId}>{shownProblem}</FieldError>}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
            <Button type="submit" disabled={problem !== null}>
              Show these days
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
