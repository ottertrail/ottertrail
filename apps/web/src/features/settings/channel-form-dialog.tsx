import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LoaderCircleIcon, OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api";
import {
  addressesFromText,
  type Channel,
  type ChannelFields,
  type ChannelKind,
  channelsQuery,
  createChannel,
  MAX_ADDRESSES,
  MAX_CHANNEL_NAME,
  updateChannel,
} from "@/lib/channels-api";
import { storageQuery } from "@/lib/storage-api";

type FieldName = "name" | "addresses" | "url";

/** Which field an API refusal belongs to, by its code. */
const FIELD_OF_ERROR: Record<string, FieldName> = {
  invalid_name: "name",
  invalid_address: "addresses",
  invalid_url: "url",
  address_not_allowed: "url",
};

const KINDS = [
  { value: "email", label: "Email" },
  { value: "webhook", label: "Webhook" },
];

interface Draft {
  kind: ChannelKind;
  name: string;
  addresses: string;
  url: string;
}

const draftOf = (channel: Channel | undefined): Draft => ({
  kind: channel?.kind ?? "email",
  name: channel?.name ?? "",
  addresses: (channel?.addresses ?? []).join("\n"),
  url: channel?.url ?? "",
});

/** The problems the form finds before sending; the API checks the rest. */
function problemsOf(draft: Draft): Partial<Record<FieldName, string>> {
  const problems: Partial<Record<FieldName, string>> = {};
  if (draft.name.trim().length > MAX_CHANNEL_NAME) {
    problems.name = `A channel's name has at most ${MAX_CHANNEL_NAME} characters.`;
  }
  if (draft.kind === "email") {
    const addresses = addressesFromText(draft.addresses);
    if (addresses.length === 0 || addresses.length > MAX_ADDRESSES) {
      problems.addresses = `Enter 1 to ${MAX_ADDRESSES} addresses.`;
    } else if (addresses.some((address) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(address))) {
      problems.addresses = "Each address looks like name@example.com.";
    }
  } else if (!/^https?:\/\/\S+$/iu.test(draft.url.trim())) {
    problems.url = "Enter a full URL that starts with https:// or http://.";
  }
  return problems;
}

const fieldsOf = (draft: Draft, adding: boolean): ChannelFields => ({
  ...(adding ? { kind: draft.kind } : {}),
  name: draft.name.trim(),
  ...(draft.kind === "email"
    ? { addresses: addressesFromText(draft.addresses) }
    : { url: draft.url.trim() }),
});

/** The form, mounted while the dialog is open, so each opening starts from the channel. */
function ChannelForm({
  channel,
  emailConfigured,
  onSaved,
}: {
  channel: Channel | undefined;
  emailConfigured: boolean;
  onSaved: (channel: Channel) => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = React.useState(() => draftOf(channel));
  const [checked, setChecked] = React.useState(false);
  const ids = {
    kind: React.useId(),
    name: React.useId(),
    addresses: React.useId(),
    url: React.useId(),
  };
  const save = useMutation({
    mutationFn: () =>
      channel === undefined
        ? createChannel(fieldsOf(draft, true))
        : updateChannel(channel.id, fieldsOf(draft, false)),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: channelsQuery().queryKey, exact: true });
      // The Storage tab lists the channels' names too (storage-tab.tsx).
      void queryClient.invalidateQueries({ queryKey: storageQuery().queryKey, exact: true });
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
      "aria-describedby": error === null ? `${ids[field]}-hint` : `${ids[field]}-error`,
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
        <DialogTitle>
          {channel === undefined ? "Add a notification channel" : `Edit “${channel.name}”`}
        </DialogTitle>
        <DialogDescription>
          Alerts go to email addresses or to your webhook as signed JSON requests.
        </DialogDescription>
      </DialogHeader>
      {channel === undefined && (
        <Field>
          <FieldLabel htmlFor={ids.kind}>Kind</FieldLabel>
          <Select
            items={KINDS}
            value={draft.kind}
            onValueChange={(next) => {
              if (next === "email" || next === "webhook") change({ kind: next });
            }}
          >
            <SelectTrigger id={ids.kind} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KINDS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
      {draft.kind === "email" ? (
        <Field data-invalid={errorOf("addresses") !== null || undefined}>
          <FieldLabel htmlFor={ids.addresses}>Addresses</FieldLabel>
          <Textarea
            {...textProps("addresses")}
            rows={4}
            spellCheck={false}
            value={draft.addresses}
            placeholder={"ops@example.com\noncall@example.com"}
            onChange={(event) => change({ addresses: event.target.value })}
          />
          {errorText("addresses") ?? (
            <FieldDescription id={`${ids.addresses}-hint`}>
              One per line, at most {MAX_ADDRESSES}.
              {!emailConfigured &&
                " This instance can't send email yet, because SMTP_URL and EMAIL_FROM aren't set on the server. You can save the channel now: it sends once whoever runs the server sets them and restarts it."}
            </FieldDescription>
          )}
        </Field>
      ) : (
        <Field data-invalid={errorOf("url") !== null || undefined}>
          <FieldLabel htmlFor={ids.url}>URL</FieldLabel>
          <Input
            {...textProps("url")}
            type="url"
            inputMode="url"
            value={draft.url}
            placeholder="https://example.com/hooks/ottertrail"
            onChange={(event) => change({ url: event.target.value })}
          />
          {errorText("url") ?? (
            <FieldDescription id={`${ids.url}-hint`}>
              Each alert is a POST with a JSON body signed with the webhook's secret. The webhook
              must return 2xx within 10 seconds. Redirects are not followed, so enter the final URL.
            </FieldDescription>
          )}
        </Field>
      )}
      <Field data-invalid={errorOf("name") !== null || undefined}>
        <FieldLabel htmlFor={ids.name}>Name</FieldLabel>
        <Input
          {...textProps("name")}
          value={draft.name}
          placeholder={draft.kind === "email" ? "The first address" : "The URL's host"}
          onChange={(event) => change({ name: event.target.value })}
        />
        {errorText("name") ?? (
          <FieldDescription id={`${ids.name}-hint`}>What alert rules call it.</FieldDescription>
        )}
      </Field>
      {checked && !valid && (
        <p role="alert" className="text-sm text-destructive">
          The channel is incomplete. Correct the marked fields above.
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
          {channel === undefined ? "Add channel" : "Save changes"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Adds a channel, or edits one, with the API's own messages beside the fields they are about. */
export function ChannelFormDialog({
  open,
  onOpenChange,
  channel,
  emailConfigured,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The channel to edit; none to add one. */
  channel?: Channel | undefined;
  emailConfigured: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <ChannelForm
          channel={channel}
          emailConfigured={emailConfigured}
          onSaved={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
