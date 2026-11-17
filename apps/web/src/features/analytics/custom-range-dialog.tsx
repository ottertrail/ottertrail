import * as React from "react";

import { Button } from "@/components/ui/button";
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

/**
 * Chosen days for the page: a first and a last day, both included, in the
 * organization's timezone. The browser's own date fields, which work from the
 * keyboard and on phones. The days are checked as the API checks them.
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
  /** The days to start from, such as the page's current ones. */
  from: string;
  to: string;
  timeZone: string | undefined;
  onApply: (from: string, to: string) => void;
}) {
  const [from, setFrom] = React.useState(initialFrom);
  const [to, setTo] = React.useState(initialTo);
  const problem = rangeProblem(from, to);
  const errorId = React.useId();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (problem === null) {
              onApply(from, to);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Custom range</DialogTitle>
            <DialogDescription>
              Whole days{timeZone === undefined ? "" : ` in ${timeZone}`}, both included, at most{" "}
              {MAX_RANGE_DAYS}.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="range-from">First day</FieldLabel>
              <Input
                id="range-from"
                type="date"
                className="scheme-dark"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                required
                aria-describedby={problem === null ? undefined : errorId}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="range-to">Last day</FieldLabel>
              <Input
                id="range-to"
                type="date"
                className="scheme-dark"
                value={to}
                min={from || undefined}
                onChange={(event) => setTo(event.target.value)}
                required
                aria-describedby={problem === null ? undefined : errorId}
              />
            </Field>
            {problem !== null && <FieldError id={errorId}>{problem}</FieldError>}
          </FieldGroup>
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
