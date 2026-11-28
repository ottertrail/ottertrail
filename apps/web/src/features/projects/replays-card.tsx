import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircleIcon, OctagonAlertIcon, Trash2Icon } from "lucide-react";
import * as React from "react";

import { CopyableCode } from "@/components/copyable-code";
import { SettingsSection } from "@/components/settings-section";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { type DirtyForm, useDirtyForm } from "@/hooks/use-dirty-form";
import { projectQuery } from "@/lib/projects-api";
import {
  deleteReplays,
  type ReplayMode,
  type ReplayOverview,
  replaysKey,
  replaysQuery,
  setReplayMode,
} from "@/lib/replays-api";
import { formatBytes } from "@/lib/source-maps-api";

import { REPLAY_CONSENT_DOCS_URL } from "./format";

export const REPLAY_ATTRIBUTE = 'data-replay="errors"';
export const CONSENT_ATTRIBUTE = 'data-replay-consent="wait"';
export const CONSENT_CALL = "window.ottertrail.replay(true);";
/** Queue calls made before the deferred tracker loads (packages/tracker/src/script.ts, docs/session-replay.md). */
export const EARLY_CALLS = `<script>
  window.ottertrail = window.ottertrail || (function () {
    var q = [];
    var p = [];
    function noop() {}
    return {
      q: q,
      p: p,
      replay: function (on) { q.push(on); },
      pageview: function (path) { p.push(path); },
      track: noop,
      identify: noop,
      reset: noop,
      captureError: noop,
      notFound: noop,
    };
  })();
</script>`;

const code = (text: string) => <code className="font-mono">{text}</code>;

const MODES: { value: ReplayMode; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "Recordings are rejected." },
  {
    value: "errors",
    label: "Around errors",
    hint: "Keeps 30 to 60 seconds in memory and sends only on an error.",
  },
];

interface ReplayValues {
  mode: ReplayMode;
}

const isMode = (value: unknown): value is ReplayMode =>
  MODES.some((choice) => choice.value === value);

function ModeChoice({ form, disabled }: { form: DirtyForm<ReplayValues>; disabled: boolean }) {
  const name = React.useId();
  const legendId = React.useId();
  return (
    <fieldset className="flex flex-col gap-3">
      <legend id={legendId} className="mb-3 text-sm font-medium text-ink">
        Record replays
      </legend>
      <RadioGroup
        name="replayMode"
        aria-labelledby={legendId}
        value={form.values.mode}
        disabled={disabled}
        onValueChange={(value) => {
          if (isMode(value)) form.set("mode", value);
        }}
        className="gap-3"
      >
        {MODES.map((choice) => (
          <Field key={choice.value} orientation="horizontal" className="items-start">
            <RadioGroupItem
              value={choice.value}
              id={`${name}-${choice.value}`}
              aria-describedby={`${name}-${choice.value}-hint`}
              className="mt-0.5"
            />
            <FieldContent>
              <FieldLabel htmlFor={`${name}-${choice.value}`}>{choice.label}</FieldLabel>
              <FieldDescription id={`${name}-${choice.value}-hint`}>{choice.hint}</FieldDescription>
            </FieldContent>
          </Field>
        ))}
      </RadioGroup>
    </fieldset>
  );
}

/** Change only the example snippet; consent is configured on the site. */
function ConsentChoice({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = React.useId();
  return (
    <Field orientation="horizontal" className="items-start">
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-describedby={`${id}-hint`}
        className="mt-0.5"
      />
      <FieldContent>
        <FieldLabel htmlFor={id}>Wait for the visitor&apos;s consent</FieldLabel>
        <FieldDescription id={`${id}-hint`}>
          Records only after your site reports consent. Changes the snippet below; nothing is saved.
        </FieldDescription>
      </FieldContent>
    </Field>
  );
}

function SiteHelp() {
  const [consent, setConsent] = React.useState(false);
  return (
    <div className="flex flex-col gap-3 text-sm text-ink-muted">
      <p>Enable recording here and add this attribute to your site's tracker tag.</p>
      <ConsentChoice checked={consent} onCheckedChange={setConsent} />
      <CopyableCode
        text={consent ? `${REPLAY_ATTRIBUTE} ${CONSENT_ATTRIBUTE}` : REPLAY_ATTRIBUTE}
        copyLabel="Copy the replay attribute"
      />
      {consent && (
        <>
          <p>
            Call this from your consent tool on every page load after consent is given. Ottertrail
            doesn't store consent; your consent tool must remember it.
          </p>
          <CopyableCode text={CONSENT_CALL} copyLabel="Copy the consent call" />
          <p>
            The tracker loads after the page. If your site may call before then, add this script
            before the tracker&apos;s tag and your consent tool&apos;s. The tracker makes the call,
            and any pageview() calls, once it loads. Until then, other tracker calls do nothing.
          </p>
          <CopyableCode text={EARLY_CALLS} copyLabel="Copy the script for early calls" />
          <p>
            {code("window.ottertrail.replay(false)")} stops recording and discards what the page
            recorded, when a visitor declines or changes their mind. The last call counts.{" "}
            <a
              href={REPLAY_CONSENT_DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="text-ink underline underline-offset-4"
            >
              Read about consent in the docs
            </a>
            .
          </p>
        </>
      )}
      <h3 className="pt-1 text-sm font-medium text-ink">Private by default</h3>
      <p>
        Page text, typed values, images, and media are masked before sending. To change masking:
      </p>
      <ul className="flex list-disc flex-col gap-1 pl-5">
        <li>
          {code('data-replay-text="show"')} on the script tag shows the page&apos;s text. Typed
          values stay masked.
        </li>
        <li>
          {code('data-replay-media="show"')} on the script tag shows images, video, and audio.
        </li>
        <li>
          {code("data-ottertrail-mask")} on an element masks its text, even when text is shown.
        </li>
        <li>{code("data-ottertrail-block")} on an element records only a box of its size.</li>
        <li>
          {code("data-ottertrail-unmask")} on an element shows its text, even when text is masked.
        </li>
      </ul>
    </div>
  );
}

/** Delete replays only; errors stay. */
function DeleteAllDialog({
  projectId,
  count,
  returnFocus,
}: {
  projectId: string;
  count: number;
  returnFocus: React.RefObject<HTMLElement | null>;
}) {
  const [open, setOpen] = React.useState(false);
  const deleted = React.useRef(false);
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => deleteReplays(projectId),
    onSuccess: () => {
      deleted.current = true;
      setOpen(false);
      // Clear the count even if refetching fails.
      queryClient.setQueryData<ReplayOverview>(replaysKey(projectId), (overview) =>
        overview === undefined
          ? undefined
          : {
              ...overview,
              replays: { count: 0, bytes: 0 },
              ...(overview.instance === undefined
                ? {}
                : {
                    instance: {
                      ...overview.instance,
                      storedBytes: Math.max(
                        0,
                        overview.instance.storedBytes - overview.replays.bytes,
                      ),
                    },
                  }),
            },
      );
      void queryClient.invalidateQueries({ queryKey: replaysKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: ["error", projectId] });
    },
  });
  const replays =
    count === 1
      ? "The project's 1 replay is"
      : `All ${count.toLocaleString("en")} replays of the project are`;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) remove.reset();
      }}
    >
      <div>
        <Button variant="outline" onClick={() => setOpen(true)}>
          <Trash2Icon aria-hidden="true" />
          Delete all replays
        </Button>
      </div>
      <DialogContent
        className="sm:max-w-md"
        finalFocus={() => (deleted.current && returnFocus.current) || true}
      >
        <DialogHeader>
          <DialogTitle>Delete all replays?</DialogTitle>
          <DialogDescription>
            {replays} permanently deleted. This cannot be undone. The errors are retained without
            their replays.
          </DialogDescription>
        </DialogHeader>
        {remove.error !== null && (
          <Alert variant="destructive" role="alert">
            <OctagonAlertIcon />
            <AlertDescription>{remove.error.message}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
          <Button variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
            {remove.isPending && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
            Delete all replays
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Usage({
  projectId,
  overview,
  returnFocus,
}: {
  projectId: string;
  overview: ReplayOverview;
  returnFocus: React.RefObject<HTMLHeadingElement | null>;
}) {
  const { count, bytes } = overview.replays;
  const { instance } = overview;
  return (
    <div className="flex flex-col gap-3 text-sm text-ink-muted">
      <p>
        <span className="text-ink tabular-nums">
          {count === 0
            ? "No replays"
            : `${count.toLocaleString("en")} ${count === 1 ? "replay" : "replays"}, ${formatBytes(bytes)}`}
        </span>{" "}
        in this project.
        {instance !== undefined && (
          <>
            {" "}
            <span className="text-ink tabular-nums">
              {formatBytes(instance.storedBytes)} of {formatBytes(instance.limitBytes)}
            </span>{" "}
            used, by all projects together.
          </>
        )}
      </p>
      <p>Replays are kept for 30 days, then deleted.</p>
      {count > 0 && (
        <DeleteAllDialog projectId={projectId} count={count} returnFocus={returnFocus} />
      )}
    </div>
  );
}

/** Replay settings require an object store (docs/session-replay.md). */
export function ReplaysSettings({
  projectId,
  onDirty,
}: {
  projectId: string;
  onDirty: (dirty: boolean) => void;
}) {
  const query = useQuery(replaysQuery(projectId));
  const form = useDirtyForm<ReplayValues>({ mode: query.data?.mode ?? "off" }, { key: projectId });
  React.useEffect(() => onDirty(form.dirty), [onDirty, form.dirty]);
  const queryClient = useQueryClient();
  // Return focus here if deletion removes the trigger.
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const save = useMutation({
    mutationFn: (values: ReplayValues) => setReplayMode(projectId, values.mode),
    onSuccess: (project, values) => {
      form.saved(values);
      queryClient.setQueryData(projectQuery(projectId).queryKey, project);
      queryClient.setQueryData<ReplayOverview>(replaysKey(projectId), (overview) =>
        overview === undefined ? undefined : { ...overview, mode: project.replayMode },
      );
      void queryClient.invalidateQueries({ queryKey: ["projects"], exact: true });
    },
  });
  const title = "Session replay";
  if (query.isPending || query.isError || !query.data.configured) {
    return (
      <SettingsSection title={title} headingRef={headingRef}>
        {query.isPending ? (
          <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : query.isError ? (
          <Alert variant="destructive">
            <OctagonAlertIcon />
            <AlertTitle>Session replay settings could not load</AlertTitle>
            <AlertDescription>{query.error.message}</AlertDescription>
            <AlertAction>
              <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        ) : (
          <p className="text-sm text-ink-muted">
            Session replay is disabled on this instance because it has no object store for
            recordings. Its operator can enable it by setting {code("OBJECT_STORE_URL")}.
          </p>
        )}
      </SettingsSection>
    );
  }
  return (
    <>
      <SettingsSection
        title={title}

        headingRef={headingRef}
        form={form}
        onSave={(values) => save.mutate(values)}
        saving={save.isPending}
        error={save.error?.message}
      >
        <ModeChoice form={form} disabled={save.isPending} />
      </SettingsSection>
      <SettingsSection title="On your site" className="border-t">
        <SiteHelp />
      </SettingsSection>
      <SettingsSection title="Stored" className="border-t">
        <Usage projectId={projectId} overview={query.data} returnFocus={headingRef} />
      </SettingsSection>
    </>
  );
}
