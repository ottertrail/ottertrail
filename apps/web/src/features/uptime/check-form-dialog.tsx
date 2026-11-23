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
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ApiError } from "@/lib/api";
import {
  type Check,
  type CheckFields,
  createCheck,
  DEFAULT_FAILURES_BEFORE_DOWN,
  DEFAULT_INTERVAL,
  DEFAULT_STATUSES,
  DEFAULT_TIMEOUT,
  INTERVALS,
  MAX_CHECK_NAME,
  MAX_FAILURES_BEFORE_DOWN,
  MAX_TIMEOUT,
  MAX_WORD,
  statusesProblem,
  updateCheck,
  urlProblem,
} from "@/lib/uptime-api";

import { intervalText } from "./format";

interface Draft {
  name: string;
  url: string;
  method: "GET" | "HEAD";
  interval: string;
  timeout: string;
  statuses: string;
  word: string;
  wordMode: "present" | "absent";
  failures: string;
}

type FieldName = "name" | "url" | "timeout" | "statuses" | "word";

const draftOf = (check: Check | undefined): Draft => ({
  name: check?.name ?? "",
  url: check?.url ?? "",
  method: check?.method ?? "GET",
  interval: String(check?.intervalSeconds ?? DEFAULT_INTERVAL),
  timeout: String(check?.timeoutSeconds ?? DEFAULT_TIMEOUT),
  statuses: check?.expectedStatuses ?? DEFAULT_STATUSES,
  word: check?.word ?? "",
  wordMode: check?.wordMode ?? "present",
  failures: String(check?.failuresBeforeDown ?? DEFAULT_FAILURES_BEFORE_DOWN),
});

function problemsOf(draft: Draft): Partial<Record<FieldName, string>> {
  const problems: Partial<Record<FieldName, string>> = {};
  if (draft.name.trim().length > MAX_CHECK_NAME) {
    problems.name = `A check's name has at most ${MAX_CHECK_NAME} characters.`;
  }
  const url = urlProblem(draft.url);
  if (url !== null) problems.url = url;
  const timeout = Number(draft.timeout);
  if (!/^\d+$/.test(draft.timeout.trim()) || timeout < 1 || timeout > MAX_TIMEOUT) {
    problems.timeout = `Enter a whole number of seconds from 1 to ${MAX_TIMEOUT}.`;
  }
  const statuses = statusesProblem(draft.statuses);
  if (statuses !== null) problems.statuses = statuses;
  if (draft.word !== "" && draft.word.trim() === "") {
    problems.word = "The word cannot be only spaces.";
  } else if (draft.word.length > MAX_WORD) {
    problems.word = `The word has at most ${MAX_WORD} characters.`;
  } else if (draft.word !== "" && draft.method === "HEAD") {
    problems.word = "HEAD has no response body. Use GET to check for text.";
  }
  return problems;
}

const FIELD_OF_ERROR: Record<string, FieldName> = {
  invalid_name: "name",
  invalid_url: "url",
  address_not_allowed: "url",
  invalid_timeout: "timeout",
  invalid_statuses: "statuses",
  invalid_word: "word",
};

const fieldsOf = (draft: Draft): CheckFields => ({
  name: draft.name.trim(),
  url: draft.url.trim(),
  method: draft.method,
  intervalSeconds: Number(draft.interval),
  timeoutSeconds: Number(draft.timeout),
  expectedStatuses: draft.statuses.trim(),
  word: draft.word === "" ? null : draft.word,
  wordMode: draft.wordMode,
  failuresBeforeDown: Number(draft.failures),
});

const METHODS = [
  { value: "GET", label: "GET" },
  { value: "HEAD", label: "HEAD" },
];
const INTERVAL_ITEMS = INTERVALS.map((seconds) => ({
  value: String(seconds),
  label: intervalText(seconds),
}));
const FAILURE_ITEMS = Array.from({ length: MAX_FAILURES_BEFORE_DOWN }, (_, index) => ({
  value: String(index + 1),
  label: index === 0 ? "1 failure" : `${index + 1} failures in a row`,
}));
const WORD_MODES = [
  { value: "present", label: "must be in the body" },
  { value: "absent", label: "must not be in the body" },
];

function SelectField({
  label,
  value,
  items,
  onChange,
  description,
}: {
  label: string;
  value: string;
  items: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  description?: string;
}) {
  const id = React.useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        items={items}
        value={value}
        onValueChange={(next) => {
          if (typeof next === "string") onChange(next);
        }}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {description !== undefined && <FieldDescription>{description}</FieldDescription>}
    </Field>
  );
}

/** Remount on open to reset to the check. */
function CheckForm({
  projectId,
  check,
  onSaved,
}: {
  projectId: string;
  check: Check | undefined;
  onSaved: (check: Check) => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = React.useState(() => draftOf(check));
  const [checked, setChecked] = React.useState(false);
  const ids = {
    name: React.useId(),
    url: React.useId(),
    timeout: React.useId(),
    statuses: React.useId(),
    word: React.useId(),
  };
  const save = useMutation({
    mutationFn: () =>
      check === undefined
        ? createCheck(projectId, fieldsOf(draft))
        : updateCheck(projectId, check.id, fieldsOf(draft)),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ["checks", projectId] });
      onSaved(saved);
    },
  });
  const problems = problemsOf(draft);
  const valid = Object.keys(problems).length === 0;
  const apiField =
    save.error instanceof ApiError && save.error.code !== undefined
      ? FIELD_OF_ERROR[save.error.code]
      : undefined;
  const errorOf = (field: FieldName): string | null =>
    (checked ? problems[field] : undefined) ??
    (apiField === field ? (save.error?.message ?? null) : null);
  const change = (next: Partial<Draft>) => {
    setDraft((previous) => ({ ...previous, ...next }));
    if (save.isError) save.reset();
  };
  const textProps = (field: FieldName) => {
    const error = errorOf(field);
    return {
      id: ids[field],
      autoComplete: "off",
      "aria-invalid": error !== null || undefined,
      "aria-describedby": error === null ? undefined : `${ids[field]}-error`,
    };
  };
  const errorText = (field: FieldName) => {
    const error = errorOf(field);
    return error === null ? null : <FieldError id={`${ids[field]}-error`}>{error}</FieldError>;
  };

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setChecked(true);
        if (valid && !save.isPending) save.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>{check === undefined ? "Add a check" : `Edit “${check.name}”`}</DialogTitle>
      </DialogHeader>
      <Field data-invalid={errorOf("url") !== null || undefined}>
        <FieldLabel htmlFor={ids.url}>URL</FieldLabel>
        <Input
          {...textProps("url")}
          type="url"
          inputMode="url"
          value={draft.url}
          placeholder="https://example.com/health"
          onChange={(event) => change({ url: event.target.value })}
        />
        {errorText("url")}
      </Field>
      <Field data-invalid={errorOf("name") !== null || undefined}>
        <FieldLabel htmlFor={ids.name}>Name</FieldLabel>
        <Input
          {...textProps("name")}
          value={draft.name}
          placeholder="The URL's host"
          onChange={(event) => change({ name: event.target.value })}
        />
        {errorText("name")}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label="How often"
          value={draft.interval}
          items={INTERVAL_ITEMS}
          onChange={(interval) => change({ interval })}
        />
        <SelectField
          label="Method"
          value={draft.method}
          items={METHODS}
          onChange={(method) => change({ method: method === "HEAD" ? "HEAD" : "GET" })}
        />
        <Field data-invalid={errorOf("timeout") !== null || undefined}>
          <FieldLabel htmlFor={ids.timeout}>Timeout (seconds)</FieldLabel>
          <Input
            {...textProps("timeout")}
            inputMode="numeric"
            value={draft.timeout}
            onChange={(event) => change({ timeout: event.target.value })}
          />
          {errorText("timeout")}
        </Field>
        <SelectField
          label="Down after"
          value={draft.failures}
          items={FAILURE_ITEMS}
          onChange={(failures) => change({ failures })}
        />
      </div>
      <Field data-invalid={errorOf("statuses") !== null || undefined}>
        <FieldLabel htmlFor={ids.statuses}>Status codes that count as up</FieldLabel>
        <Input
          {...textProps("statuses")}
          value={draft.statuses}
          placeholder={DEFAULT_STATUSES}
          onChange={(event) => change({ statuses: event.target.value })}
        />
        {errorText("statuses") ?? (
          <FieldDescription>
            Enter codes and ranges separated by commas. The check follows at most 5 redirects.
          </FieldDescription>
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field data-invalid={errorOf("word") !== null || undefined}>
          <FieldLabel htmlFor={ids.word}>Word (optional)</FieldLabel>
          <Input
            {...textProps("word")}
            value={draft.word}
            placeholder="healthy"
            onChange={(event) => change({ word: event.target.value })}
          />
          {errorText("word") ?? (
            <FieldDescription>
              The check searches the body's first megabyte for the exact text.
            </FieldDescription>
          )}
        </Field>
        <SelectField
          label="The word"
          value={draft.wordMode}
          items={WORD_MODES}
          onChange={(mode) => change({ wordMode: mode === "absent" ? "absent" : "present" })}
        />
      </div>
      {checked && !valid && (
        <p role="alert" className="text-sm text-destructive">
          The check is incomplete. Correct the marked fields above.
        </p>
      )}
      {save.error !== null && apiField === undefined && (
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
          {check === undefined ? "Add check" : "Save changes"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function CheckFormDialog({
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
        <CheckForm
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
