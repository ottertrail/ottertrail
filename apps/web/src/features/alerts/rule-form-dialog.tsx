import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { LoaderCircleIcon, OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createRule,
  DEFAULT_CERTIFICATE_DAYS,
  DEFAULT_THRESHOLD,
  DEFAULT_WINDOW_MINUTES,
  KIND_LABEL,
  MAX_CERTIFICATE_DAYS,
  MAX_RULE_NAME,
  MAX_THRESHOLD,
  MAX_WINDOW_MINUTES,
  MIN_WINDOW_MINUTES,
  type Rule,
  type RuleFields,
  type RuleKind,
  RULE_KINDS,
  type RuleSettings,
  updateRule,
} from "@/lib/alerts-api";
import { ApiError } from "@/lib/api";
import type { Channel } from "@/lib/channels-api";
import type { Check } from "@/lib/uptime-api";

/** What a new rule starts with: a kind, and what the page it came from knows. */
export interface RulePrefill {
  add?: RuleKind | undefined;
  check?: string | undefined;
  fingerprint?: string | undefined;
  env?: string | undefined;
}

/** The form's fields, as typed. */
interface Draft {
  kind: RuleKind;
  name: string;
  /** "" for all the project's checks. */
  checkId: string;
  days: string;
  environment: string;
  fingerprint: string;
  windowMinutes: string;
  threshold: string;
  channelIds: string[];
}

type FieldName =
  | "name"
  | "days"
  | "environment"
  | "fingerprint"
  | "windowMinutes"
  | "threshold"
  | "channels"
  | "checkId";

const ALL_CHECKS = "";
const ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FINGERPRINT = /^[0-9]{1,3}-[0-9a-f]{20}$/;

function draftOf(
  rule: Rule | undefined,
  prefill: RulePrefill,
  channels: readonly Channel[],
): Draft {
  const settings: RuleSettings = rule?.settings ?? {};
  return {
    kind: rule?.kind ?? prefill.add ?? "check_down",
    name: rule?.name ?? "",
    checkId: settings.checkId ?? prefill.check ?? ALL_CHECKS,
    days: String(settings.days ?? DEFAULT_CERTIFICATE_DAYS),
    environment: settings.environment ?? prefill.env ?? "",
    fingerprint: settings.fingerprint ?? prefill.fingerprint ?? "",
    windowMinutes: String(settings.windowMinutes ?? DEFAULT_WINDOW_MINUTES),
    threshold: String(settings.threshold ?? DEFAULT_THRESHOLD),
    // A channel deleted meanwhile is dropped, so the rule can be saved; a
    // new rule sends to the only channel there is, if there is one.
    channelIds:
      rule?.channelIds.filter((id) => channels.some((channel) => channel.id === id)) ??
      (channels.length === 1 && channels[0] !== undefined ? [channels[0].id] : []),
  };
}

const wholeIn = (text: string, min: number, max: number) =>
  /^\d+$/.test(text.trim()) && Number(text) >= min && Number(text) <= max;

/** The problems the form finds before sending, as the API would. */
function problemsOf(draft: Draft): Partial<Record<FieldName, string>> {
  const problems: Partial<Record<FieldName, string>> = {};
  if (draft.name.trim().length > MAX_RULE_NAME) {
    problems.name = `A rule's name has at most ${MAX_RULE_NAME} characters.`;
  }
  if (draft.channelIds.length === 0) problems.channels = "Choose at least one channel.";
  if (draft.kind === "certificate_expiring" && !wholeIn(draft.days, 1, MAX_CERTIFICATE_DAYS)) {
    problems.days = `Enter a whole number of days from 1 to ${MAX_CERTIFICATE_DAYS}.`;
  }
  if (draft.kind === "error_new" || draft.kind === "error_spike") {
    const environment = draft.environment.trim();
    if (environment !== "" && !ENVIRONMENT.test(environment)) {
      problems.environment =
        "An environment has 1 to 64 letters, digits, dots, dashes, or underscores, such as production.";
    }
  }
  if (draft.kind === "error_spike") {
    const group = draft.fingerprint.trim();
    if (group !== "" && !FINGERPRINT.test(group)) {
      problems.fingerprint = "Paste the group's ID from its page, such as 1-0123456789abcdef0123.";
    }
    if (!wholeIn(draft.windowMinutes, MIN_WINDOW_MINUTES, MAX_WINDOW_MINUTES)) {
      problems.windowMinutes = `Enter a whole number of minutes from ${MIN_WINDOW_MINUTES} to ${MAX_WINDOW_MINUTES}.`;
    }
    if (!wholeIn(draft.threshold, 1, MAX_THRESHOLD)) {
      problems.threshold = `Enter a whole number of errors from 1 to ${MAX_THRESHOLD.toLocaleString("en")}.`;
    }
  }
  return problems;
}

/** Which field an API refusal belongs to, by its code. */
const FIELD_OF_ERROR: Record<string, FieldName> = {
  invalid_name: "name",
  invalid_days: "days",
  invalid_window: "windowMinutes",
  invalid_threshold: "threshold",
  invalid_channels: "channels",
  channel_not_found: "channels",
  check_not_found: "checkId",
};

function settingsOf(draft: Draft): RuleSettings {
  const environment = draft.environment.trim() === "" ? null : draft.environment.trim();
  switch (draft.kind) {
    case "check_down":
      return { checkId: draft.checkId === ALL_CHECKS ? null : draft.checkId };
    case "certificate_expiring":
      return {
        checkId: draft.checkId === ALL_CHECKS ? null : draft.checkId,
        days: Number(draft.days),
      };
    case "error_new":
      return { environment };
    case "error_regressed":
      return {};
    case "error_spike":
      return {
        environment,
        fingerprint: draft.fingerprint.trim() === "" ? null : draft.fingerprint.trim(),
        windowMinutes: Number(draft.windowMinutes),
        threshold: Number(draft.threshold),
      };
    default:
      return {};
  }
}

const fieldsOf = (draft: Draft): RuleFields => ({
  name: draft.name.trim(),
  kind: draft.kind,
  settings: settingsOf(draft),
  channelIds: draft.channelIds,
});

/** What each kind does, under its choice. */
const KIND_HELP: Record<RuleKind, string> = {
  check_down: "Sends when a check goes down, and again when it is up.",
  certificate_expiring:
    "Sends once for each certificate that comes within the days of its expiry, and again when it is renewed.",
  error_new:
    "Sends once for each error group seen for the first time after the rule is added. Groups seen before are not new.",
  error_regressed:
    "Sends once each time an error group resolved in the dashboard happens again, in any environment.",
  error_spike:
    "Sends when the errors in the window reach the threshold, and again once they stay below it for a whole window.",
};

/** A select with its label, as the form's other fields are. */
function SelectField({
  label,
  value,
  items,
  onChange,
  description,
  error,
}: {
  label: string;
  value: string;
  items: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  description?: string;
  error?: string | null;
}) {
  const id = React.useId();
  return (
    <Field data-invalid={(error ?? null) !== null || undefined}>
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
      {(error ?? null) !== null ? (
        <FieldError>{error}</FieldError>
      ) : (
        description !== undefined && <FieldDescription>{description}</FieldDescription>
      )}
    </Field>
  );
}

const KIND_ITEMS = RULE_KINDS.map((kind) => ({ value: kind, label: KIND_LABEL[kind] }));

/** The form, mounted while the dialog is open, so each opening starts afresh. */
function RuleForm({
  projectId,
  rule,
  prefill,
  checks,
  channels,
  onSaved,
}: {
  projectId: string;
  rule: Rule | undefined;
  prefill: RulePrefill;
  checks: readonly Pick<Check, "id" | "name">[];
  channels: readonly Channel[];
  onSaved: (rule: Rule) => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = React.useState(() => draftOf(rule, prefill, channels));
  const [checked, setChecked] = React.useState(false);
  const ids = {
    name: React.useId(),
    days: React.useId(),
    environment: React.useId(),
    fingerprint: React.useId(),
    windowMinutes: React.useId(),
    threshold: React.useId(),
  };
  const save = useMutation({
    mutationFn: () =>
      rule === undefined
        ? createRule(projectId, fieldsOf(draft))
        : updateRule(projectId, rule.id, fieldsOf(draft)),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ["alerts", projectId] });
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
  const textField = (
    field: Exclude<FieldName, "channels" | "checkId">,
    label: string,
    more: { placeholder?: string; description?: string; numeric?: boolean } = {},
  ) => {
    const error = errorOf(field);
    const id = ids[field];
    return (
      <Field data-invalid={error !== null || undefined}>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Input
          id={id}
          autoComplete="off"
          inputMode={more.numeric === true ? "numeric" : undefined}
          aria-invalid={error !== null || undefined}
          aria-describedby={error === null ? undefined : `${id}-error`}
          value={draft[field]}
          placeholder={more.placeholder}
          onChange={(event) => change({ [field]: event.target.value })}
        />
        {error !== null ? (
          <FieldError id={`${id}-error`}>{error}</FieldError>
        ) : (
          more.description !== undefined && <FieldDescription>{more.description}</FieldDescription>
        )}
      </Field>
    );
  };
  const checkItems = [
    { value: ALL_CHECKS, label: "All the project's checks" },
    ...checks.map((check) => ({ value: check.id, label: check.name })),
    // A check the rule names that the project no longer has, so the select still shows it.
    ...(draft.checkId !== ALL_CHECKS && !checks.some((check) => check.id === draft.checkId)
      ? [{ value: draft.checkId, label: "A check that was deleted" }]
      : []),
  ];
  const channelsError = errorOf("channels");

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
        <DialogTitle>
          {rule === undefined ? "Add an alert rule" : `Edit “${rule.name}”`}
        </DialogTitle>
        <DialogDescription>
          A rule watches the project and sends a notification to its channels when something
          happens, and again when it is over.
        </DialogDescription>
      </DialogHeader>
      <SelectField
        label="When"
        value={draft.kind}
        items={KIND_ITEMS}
        onChange={(kind) => {
          const found = RULE_KINDS.find((item) => item === kind);
          if (found !== undefined) change({ kind: found });
        }}
        description={KIND_HELP[draft.kind]}
      />
      {(draft.kind === "check_down" || draft.kind === "certificate_expiring") && (
        <SelectField
          label="Check"
          value={draft.checkId}
          items={checkItems}
          onChange={(checkId) => change({ checkId })}
          error={errorOf("checkId")}
          description={
            draft.checkId === ALL_CHECKS ? "Checks added later are watched too." : undefined
          }
        />
      )}
      {draft.kind === "certificate_expiring" &&
        textField("days", "Days before it expires", { numeric: true })}
      {(draft.kind === "error_new" || draft.kind === "error_spike") &&
        textField("environment", "Environment (optional)", {
          placeholder: "All environments",
          description: "Leave empty to watch every environment.",
        })}
      {draft.kind === "error_spike" && (
        <>
          {textField("fingerprint", "Error group (optional)", {
            placeholder: "All errors",
            description: "Leave empty to count every error; an error's page fills this in.",
          })}
          <div className="grid gap-4 sm:grid-cols-2">
            {textField("threshold", "Errors", {
              numeric: true,
              description: "Sends when the count reaches this.",
            })}
            {textField("windowMinutes", "In the last (minutes)", {
              numeric: true,
              description: `${MIN_WINDOW_MINUTES} to ${MAX_WINDOW_MINUTES} minutes.`,
            })}
          </div>
        </>
      )}
      {textField("name", "Name (optional)", { placeholder: KIND_LABEL[draft.kind] })}
      <FieldSet data-invalid={channelsError !== null || undefined}>
        <FieldLegend variant="label">Send to</FieldLegend>
        {channels.length === 0 ? (
          <p className="text-sm text-ink-subtle">
            This instance has no notification channels.{" "}
            <Link to="/settings" className="text-link hover:underline">
              Add one in Settings
            </Link>
            .
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {channels.map((channel) => {
              const id = `rule-channel-${channel.id}`;
              const on = draft.channelIds.includes(channel.id);
              return (
                <Field orientation="horizontal" key={channel.id}>
                  <Checkbox
                    id={id}
                    checked={on}
                    onCheckedChange={(next) =>
                      change({
                        channelIds: next
                          ? [...draft.channelIds, channel.id]
                          : draft.channelIds.filter((item) => item !== channel.id),
                      })
                    }
                  />
                  <FieldLabel htmlFor={id} className="font-normal">
                    {channel.name}
                    <span className="text-ink-subtle">
                      {channel.kind === "email" ? " · email" : " · webhook"}
                    </span>
                  </FieldLabel>
                </Field>
              );
            })}
          </div>
        )}
        {channelsError !== null && <FieldError>{channelsError}</FieldError>}
      </FieldSet>
      {checked && !valid && (
        <p role="alert" className="text-sm text-destructive">
          The rule is not complete. Fix the fields marked above.
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
          {save.isPending && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
          {rule === undefined ? "Add rule" : "Save changes"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Adds a rule or edits one, with the API's own messages beside the fields they are about. */
export function RuleFormDialog({
  open,
  onOpenChange,
  projectId,
  rule,
  prefill = {},
  checks,
  channels,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** The rule to edit; none to add one. */
  rule?: Rule | undefined;
  prefill?: RulePrefill;
  checks: readonly Pick<Check, "id" | "name">[];
  channels: readonly Channel[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <RuleForm
          projectId={projectId}
          rule={rule}
          prefill={prefill}
          checks={checks}
          channels={channels}
          onSaved={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
