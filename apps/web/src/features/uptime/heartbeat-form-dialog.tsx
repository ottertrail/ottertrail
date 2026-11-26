import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LoaderCircleIcon, OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import {
  createHeartbeat,
  DEFAULT_PERIOD,
  defaultGrace,
  HEARTBEAT_GRACES,
  HEARTBEAT_PERIODS,
  periodText,
  spanText,
  updateHeartbeat,
} from "@/lib/heartbeat-api";
import { type Check, MAX_CHECK_NAME } from "@/lib/uptime-api";

import { SelectField } from "./check-form-dialog";

const PERIOD_ITEMS = HEARTBEAT_PERIODS.map((seconds) => ({
  value: String(seconds),
  label: periodText(seconds),
}));
const GRACE_ITEMS = HEARTBEAT_GRACES.map((seconds) => ({
  value: String(seconds),
  label: spanText(seconds),
}));

function nameProblem(name: string): string | null {
  if (name.trim() === "") return "Enter a name for the heartbeat.";
  if (name.trim().length > MAX_CHECK_NAME) {
    return `A check's name has at most ${MAX_CHECK_NAME} characters.`;
  }
  return null;
}

/** Remount on open to reset to the heartbeat. */
function HeartbeatForm({
  projectId,
  check,
  onSaved,
}: {
  projectId: string;
  check: Check | undefined;
  onSaved: (check: Check) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = React.useState(check?.name ?? "");
  const [period, setPeriod] = React.useState(String(check?.intervalSeconds ?? DEFAULT_PERIOD));
  const [grace, setGrace] = React.useState(
    String(check?.graceSeconds ?? defaultGrace(DEFAULT_PERIOD)),
  );
  // A new heartbeat's grace follows the period until it is chosen.
  const [graceChosen, setGraceChosen] = React.useState(check !== undefined);
  const [checked, setChecked] = React.useState(false);
  const nameId = React.useId();
  const save = useMutation({
    mutationFn: () => {
      const fields = {
        name: name.trim(),
        intervalSeconds: Number(period),
        graceSeconds: Number(grace),
      };
      return check === undefined
        ? createHeartbeat(projectId, fields)
        : updateHeartbeat(projectId, check.id, fields);
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ["checks", projectId] });
      onSaved(saved);
    },
  });
  const nameError =
    (checked ? nameProblem(name) : null) ??
    (save.error instanceof ApiError && save.error.code === "invalid_name"
      ? save.error.message
      : null);
  const reset = () => {
    if (save.isError) save.reset();
  };

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setChecked(true);
        if (nameProblem(name) === null && !save.isPending) save.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {check === undefined ? "Add a heartbeat" : `Edit “${check.name}”`}
        </DialogTitle>
      </DialogHeader>
      <Field data-invalid={nameError !== null || undefined}>
        <FieldLabel htmlFor={nameId}>Name</FieldLabel>
        <Input
          id={nameId}
          autoComplete="off"
          value={name}
          placeholder="Nightly backup"
          aria-invalid={nameError !== null || undefined}
          aria-describedby={nameError === null ? undefined : `${nameId}-error`}
          onChange={(event) => {
            setName(event.target.value);
            reset();
          }}
        />
        {nameError !== null && <FieldError id={`${nameId}-error`}>{nameError}</FieldError>}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label="Expected"
          value={period}
          items={PERIOD_ITEMS}
          onChange={(next) => {
            setPeriod(next);
            if (!graceChosen) setGrace(String(defaultGrace(Number(next))));
            reset();
          }}
        />
        <SelectField
          label="Grace time"
          value={grace}
          items={GRACE_ITEMS}
          onChange={(next) => {
            setGrace(next);
            setGraceChosen(true);
            reset();
          }}
          description="How late a ping may be before the heartbeat is down."
        />
      </div>
      {save.error !== null &&
        !(save.error instanceof ApiError && save.error.code === "invalid_name") && (
          <Alert variant="destructive" role="alert">
            <OctagonAlertIcon />
            <AlertDescription>{save.error.message}</AlertDescription>
          </Alert>
        )}
      <DialogFooter>
        <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && (
            <LoaderCircleIcon
              aria-hidden="true"
              className="animate-spin motion-reduce:animate-none"
            />
          )}
          {check === undefined ? "Add heartbeat" : "Save changes"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function HeartbeatFormDialog({
  open,
  onOpenChange,
  projectId,
  check,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  check?: Check | undefined;
  onSaved?: (check: Check) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <HeartbeatForm
          projectId={projectId}
          check={check}
          onSaved={(saved) => {
            onOpenChange(false);
            onSaved?.(saved);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
