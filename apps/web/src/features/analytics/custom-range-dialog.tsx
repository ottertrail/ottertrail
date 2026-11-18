import * as React from "react";
import type { DateRange } from "react-day-picker";
import { enGB } from "react-day-picker/locale";

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
import { Input } from "@/components/ui/input";
import { MAX_RANGE_DAYS, rangeProblem } from "@/lib/analytics-api";

import {
  DAY_PLACEHOLDER,
  DAY_TEXT_LENGTH,
  dateOf,
  dayFromText,
  dayOf,
  dayText,
  maskDay,
} from "./day-text";

/**
 * One typed day: digits only, the slashes come by themselves (maskDay). The
 * field's text and cursor are set within the same event that changed them,
 * so no keystroke is lost however fast they come.
 */
function DayInput({
  id,
  text,
  onTextChange,
  onBlur,
  invalid,
  describedBy,
}: {
  id: string;
  text: string;
  onTextChange: (text: string) => void;
  onBlur: () => void;
  invalid: boolean;
  describedBy: string | undefined;
}) {
  return (
    <Input
      id={id}
      value={text}
      onChange={(event) => {
        const input = event.currentTarget;
        const masked = maskDay(input.value, input.selectionStart ?? input.value.length);
        // Before React renders: the text then already matches, so React
        // leaves the field, and its cursor, alone.
        input.value = masked.text;
        input.setSelectionRange(masked.cursor, masked.cursor);
        onTextChange(masked.text);
      }}
      onKeyDown={(event) => {
        // Backspace right after a slash deletes the digit before it, and
        // Delete right before one the digit after it: the slash alone would
        // only come back.
        const input = event.currentTarget;
        const at = input.selectionStart ?? 0;
        if (at !== input.selectionEnd) return;
        if (event.key === "Backspace" && input.value[at - 1] === "/") {
          input.setSelectionRange(at - 1, at - 1);
        } else if (event.key === "Delete" && input.value[at] === "/") {
          input.setSelectionRange(at + 1, at + 1);
        }
      }}
      onBlur={onBlur}
      placeholder={DAY_PLACEHOLDER}
      inputMode="numeric"
      autoComplete="off"
      required
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
    />
  );
}

/**
 * Chosen days for the page: a first and a last day, both included, in the
 * timezone set in Settings. Picked in the calendar (a first click, then a
 * last), or typed, day first. Either way, the days are checked as the API
 * checks them.
 */
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
  // A half-typed day is not an error yet: only once complete, left, or sent.
  const [checked, setChecked] = React.useState({ from: false, to: false });
  // The month the calendar shows: where the range ends, then wherever typing goes.
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
  // Each field's own problem waits for that field; the range's for both.
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
            // A click on a complete range starts a new one: first day, then last.
            resetOnSelect
            locale={enGB}
            selected={{ from: dateOf(from ?? ""), to: dateOf(to ?? "") }}
            onSelect={picked}
            month={month}
            onMonthChange={setMonth}
            // Larger days than the default, and the dialog's own background.
            className="mx-auto rounded-lg border bg-transparent [--cell-size:--spacing(9)]"
            classNames={{
              // Today underlined, not filled: a fill reads as part of a range.
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
                describedBy={describedBy}
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
                describedBy={describedBy}
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
