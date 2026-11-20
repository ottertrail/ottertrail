import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DownloadIcon,
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  OctagonAlertIcon,
  TriangleAlertIcon,
} from "lucide-react";
import * as React from "react";

import { CopyableCode } from "@/components/copyable-code";
import { Missing } from "@/components/missing";
import { SettingsSection } from "@/components/settings-section";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useDirtyForm } from "@/hooks/use-dirty-form";
import {
  type BackupChanges,
  backupListQuery,
  type BackupRun,
  type Backups,
  backupsQuery,
  backUpNow,
  type BackupKey,
  confirmKeySaved,
  type ConnectionStep,
  type ConnectionTest,
  fetchBackupKey,
  fetchBackupKeyFile,
  replaceKey,
  testConnection,
  testRestore,
  updateBackups,
} from "@/lib/backups-api";
import { formatBytes } from "@/lib/source-maps-api";

import { formatMoment, formatSpan } from "../uptime/format";
import { type InstanceTabProps, SectionFailed, SectionSkeleton } from "./section-states";

/**
 * The Backups tab of the instance's Settings (`?tab=backups`), for the
 * owner only (docs/dashboard.md, "Backups"): the last backup and the next,
 * Back up now and Test restore, the backups in the bucket; the schedule
 * and the destination, one form under the save rule, with Test connection;
 * and the backup key, shown on request, with a reminder until the owner
 * says it is saved.
 */

/** While the worker has work under way or asked for, the tab reads the status again this often. */
const POLL_MS = 5000;

const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

const TRIGGER_TEXT: Record<BackupRun["trigger"], string> = {
  schedule: "the daily backup",
  manual: "Back up now",
  retry: "the retry of a failed backup",
};

/** When a run ended (or started, while it runs), in the instance's timezone. */
const runTime = (run: BackupRun, timeZone: string) =>
  formatMoment(run.finishedAt ?? run.startedAt, timeZone);

function RunBadge({ run }: { run: BackupRun }) {
  const [tone, text]: [StatusTone, string] =
    run.status === "succeeded"
      ? ["good", run.kind === "backup" ? "Succeeded" : "Passed"]
      : run.status === "failed"
        ? ["critical", "Failed"]
        : ["neutral", "Running"];
  return (
    <StatusBadge
      tone={tone}
      icon={
        run.status === "running" ? (
          <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
        ) : undefined
      }
    >
      {text}
    </StatusBadge>
  );
}

/** One line of the status: a label and its value. */
function StatusRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[10rem_1fr] sm:gap-4">
      <dt className="text-sm text-ink-subtle">{label}</dt>
      <dd className="flex flex-wrap items-center gap-2 text-sm text-ink">{children}</dd>
    </div>
  );
}

/** The backups in the destination's folder, newest first. */
function BucketList({ timeZone, refreshKey }: { timeZone: string; refreshKey: string }) {
  // A backup that finished (and retention after it), or another folder, changes the list.
  const list = useQuery({
    queryKey: [...backupListQuery().queryKey, refreshKey],
    queryFn: backupListQuery().queryFn,
  });
  if (list.isPending) {
    return (
      <p className="text-sm text-ink-subtle" aria-busy="true">
        Listing the backups in the bucket…
      </p>
    );
  }
  if (list.isError || !list.data.ok) {
    return (
      <Alert variant="destructive">
        <OctagonAlertIcon />
        <AlertTitle>The backups in the bucket could not be listed</AlertTitle>
        <AlertDescription>
          {list.isError ? list.error.message : list.data.ok ? "" : sentence(list.data.error)}
        </AlertDescription>
        <AlertAction>
          <Button type="button" variant="outline" size="sm" onClick={() => void list.refetch()}>
            Retry
          </Button>
        </AlertAction>
      </Alert>
    );
  }
  const { backups, bucket, prefix } = list.data;
  if (backups.length === 0) {
    return (
      <p className="text-sm text-ink-subtle">
        No backups in {bucket}/{prefix} yet. The first one appears here after the next backup.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <Table aria-label="Backups in the bucket">
        <TableHeader>
          <TableRow>
            <TableHead>Started</TableHead>
            <TableHead className="text-right">Size</TableHead>
            <TableHead>State</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {backups.map((backup) => (
            <TableRow key={backup.name}>
              <TableCell className="tabular-nums">{formatMoment(backup.at, timeZone)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatBytes(backup.bytes)}</TableCell>
              <TableCell>
                {backup.complete ? (
                  <StatusBadge tone="good">Whole</StatusBadge>
                ) : (
                  <StatusBadge tone="warning">Incomplete</StatusBadge>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-sm text-ink-subtle">
        In {bucket}/{prefix}. Incomplete ones have no manifest, so they can't be restored; the
        worker deletes them after a day.
      </p>
    </div>
  );
}

/** The last backup, the next one, the actions, and what the bucket holds. */
function StatusSection({ data, timeZone }: { data: Backups; timeZone: string }) {
  const queryClient = useQueryClient();
  const { settings, status, key } = data;
  const setData = (updated: Backups) => queryClient.setQueryData(backupsQuery().queryKey, updated);
  const run = useMutation({ mutationFn: backUpNow, onSuccess: setData });
  const restore = useMutation({ mutationFn: testRestore, onSuccess: setData });
  const last = status.lastBackup;
  const running = status.running;
  const busy = running !== null || status.backupRequested || status.testRestoreRequested;
  const off = !settings.enabled;

  return (
    <SettingsSection
      title="Backups"
      description="The worker backs up PostgreSQL, ClickHouse, and the object store's files every day, encrypts each part with the backup key, and uploads them to the destination below."
    >
      {off && last === null ? (
        <p className="text-sm text-ink-subtle">
          Backups are off. Turn them on under Schedule and destination, choose where they go, and
          save: the worker then backs up every day at the time you pick.
        </p>
      ) : (
        <dl className="flex flex-col gap-3">
          <StatusRow label="Last backup">
            {last === null ? (
              <Missing label="None yet" />
            ) : (
              <>
                <RunBadge run={last} />
                <span className="tabular-nums">{runTime(last, timeZone)}</span>
                {last.status === "succeeded" && last.bytes !== null && (
                  <span className="text-ink-subtle">
                    {formatBytes(last.bytes)}
                    {last.durationMs !== null && `, took ${formatSpan(last.durationMs)}`}
                  </span>
                )}
              </>
            )}
          </StatusRow>
          {running !== null && (
            <StatusRow label="Now">
              <RunBadge run={running} />
              {running.kind === "backup" ? "Backing up" : "Testing the restore"} (
              {TRIGGER_TEXT[running.trigger]}), since {formatMoment(running.startedAt, timeZone)}.
            </StatusRow>
          )}
          <StatusRow label="Next backup">
            {status.nextDueAt === null ? (
              <Missing label="Off" />
            ) : (
              <span className="tabular-nums">
                {formatMoment(status.nextDueAt, timeZone)}
                {Date.parse(status.nextDueAt) <= Date.parse(status.now) && " (due now)"}
              </span>
            )}
          </StatusRow>
          {status.lastSuccess !== null && last?.status === "failed" && (
            <StatusRow label="Last good backup">
              <span className="tabular-nums">{runTime(status.lastSuccess, timeZone)}</span>
            </StatusRow>
          )}
        </dl>
      )}

      {last?.status === "failed" && (
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertTitle>The last backup failed</AlertTitle>
          <AlertDescription className="text-pretty">
            {sentence(last.error ?? "No reason was recorded.")}{" "}
            {status.retryAt !== null
              ? `The worker tries once more at ${formatMoment(status.retryAt, timeZone)}.`
              : "Fix what it says, then use Back up now, or wait for the next daily backup."}
          </AlertDescription>
        </Alert>
      )}
      {status.overdueSince !== null && (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>A backup is overdue</AlertTitle>
          <AlertDescription className="text-pretty">
            No backup has worked since the one due {formatMoment(status.overdueSince, timeZone)}.
            The worker may be stopped: check that it runs (docker compose ps), or use Back up now.
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={off || run.isPending || running !== null || status.backupRequested}
            onClick={() => run.mutate()}
          >
            Back up now
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={key.state === "none" || restore.isPending || busy}
            onClick={() => restore.mutate()}
          >
            Test restore
          </Button>
        </div>
        <p className="text-sm text-ink-subtle" aria-live="polite">
          {status.backupRequested
            ? "Back up now is asked for: the worker starts it within a minute."
            : status.testRestoreRequested
              ? "Test restore is asked for: the worker starts it within a minute."
              : off
                ? "Back up now needs backups turned on and saved."
                : "Test restore downloads the newest backup, decrypts every part, and checks each checksum, without restoring anything."}
        </p>
        {(run.error ?? restore.error) !== null && (
          <p role="alert" className="text-sm text-destructive">
            {(run.error ?? restore.error)?.message}
          </p>
        )}
      </div>

      {status.lastTestRestore !== null && (
        <dl className="flex flex-col gap-3">
          <StatusRow label="Last test restore">
            <RunBadge run={status.lastTestRestore} />
            <span className="tabular-nums">{runTime(status.lastTestRestore, timeZone)}</span>
            {status.lastTestRestore.status === "succeeded" && (
              <span className="text-ink-subtle">
                Backup {status.lastTestRestore.folder} decrypted, and every checksum matched.
              </span>
            )}
          </StatusRow>
          {status.lastTestRestore.status === "failed" && (
            <dd className="text-sm text-pretty text-destructive">
              {sentence(status.lastTestRestore.error ?? "No reason was recorded.")}
            </dd>
          )}
        </dl>
      )}

      {settings.enabled && (
        <section aria-label="Backups in the bucket" className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-ink">In the bucket</h3>
          <BucketList
            timeZone={timeZone}
            refreshKey={`${status.lastSuccess?.startedAt ?? ""}|${settings.bucket ?? ""}|${settings.prefix}`}
          />
        </section>
      )}
    </SettingsSection>
  );
}

interface Values {
  enabled: boolean;
  timeOfDay: string;
  keepDays: string;
  bucket: string;
  prefix: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  /** Typed only to save a new one: the saved secret is never shown. */
  secretAccessKey: string;
}

function valuesOf(data: Backups): Values {
  const { settings } = data;
  return {
    enabled: settings.enabled,
    timeOfDay: settings.timeOfDay,
    keepDays: String(settings.keepDays),
    bucket: settings.bucket ?? "",
    prefix: settings.prefix,
    endpoint: settings.endpoint ?? "",
    region: settings.region ?? "",
    accessKeyId: settings.accessKeyId ?? "",
    secretAccessKey: "",
  };
}

const orNull = (text: string) => (text.trim() === "" ? null : text.trim());

/** The destination's fields as the API takes them: a separate one's only when it has one. */
function destinationFields(values: Values, separate: boolean) {
  return {
    bucket: orNull(values.bucket),
    prefix: values.prefix.trim(),
    ...(separate
      ? {
          endpoint: orNull(values.endpoint),
          region: orNull(values.region),
          accessKeyId: orNull(values.accessKeyId),
          ...(values.secretAccessKey === "" ? {} : { secretAccessKey: values.secretAccessKey }),
        }
      : {}),
  };
}

const STEP_TEXT: Record<ConnectionStep["step"], string> = {
  put: "Write a test file in the folder",
  list: "List the folder",
  get: "Read the file back",
  delete: "Delete it",
};

function ConnectionResult({ result }: { result: ConnectionTest }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium text-ink">
        {result.ok
          ? "The connection works: every step did."
          : "The connection does not work yet: a step failed."}
      </p>
      <ul aria-label="Test connection steps" className="flex flex-col gap-1.5">
        {result.steps.map((step) => (
          <li key={step.step} className="flex flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-2 text-sm text-ink">
              <StatusBadge
                tone={
                  step.status === "ok" ? "good" : step.status === "failed" ? "critical" : "neutral"
                }
              >
                {step.status === "ok" ? "Worked" : step.status === "failed" ? "Failed" : "Skipped"}
              </StatusBadge>
              {STEP_TEXT[step.step]}
            </span>
            {step.error !== undefined && (
              <span className="text-sm text-pretty text-destructive">{step.error}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Why the destination is what it is, in words: the copy rule's what and why. */
function DestinationText({ data }: { data: Backups }) {
  const { destination } = data;
  if (destination.mode === "object_store") {
    return (
      <p className="text-sm text-pretty text-ink-subtle">
        Backups go to the object store that holds session replays and source maps (
        {new URL(destination.objectStore.endpoint).host}), which is off this server, with its access
        key. Choose a bucket and a folder for them: the worker lists and deletes only inside that
        folder.
      </p>
    );
  }
  return (
    <p className="text-sm text-pretty text-ink-subtle">
      {destination.reason === "stack_garage"
        ? "Replays and source maps are in this stack's own Garage, on this server's disk: a backup there would be lost with the server. "
        : "This instance has no object store, so backups need a destination of their own. "}
      Enter an S3-compatible bucket somewhere else, such as Amazon S3, Cloudflare R2, or Backblaze
      B2, with an access key that may write, list, read, and delete in it.
    </p>
  );
}

/** The schedule and the destination: one form, with its Save bar and Test connection. */
function SettingsForm({
  data,
  timeZone,
  onDirty,
}: {
  data: Backups;
  timeZone: string;
  onDirty: (dirty: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const form = useDirtyForm(valuesOf(data), {
    normalize: {
      keepDays: (days) => Number(days),
      bucket: (text) => text.trim(),
      prefix: (text) => text.trim(),
      endpoint: (text) => text.trim(),
      region: (text) => text.trim(),
      accessKeyId: (text) => text.trim(),
    },
  });
  React.useEffect(() => onDirty(form.dirty), [onDirty, form.dirty]);
  const separate = data.destination.mode === "separate";
  const save = useMutation({
    mutationFn: (values: Values) => {
      const changes: BackupChanges = {
        enabled: values.enabled,
        timeOfDay: values.timeOfDay,
        keepDays: Number(values.keepDays),
        ...destinationFields(values, separate),
      };
      return updateBackups(changes);
    },
    onSuccess: (updated, values) => {
      // The secret field empties once saved: it is never shown again.
      form.setValues((previous) =>
        previous.secretAccessKey === values.secretAccessKey
          ? { ...previous, secretAccessKey: "" }
          : previous,
      );
      form.saved({ ...values, secretAccessKey: "" });
      queryClient.setQueryData(backupsQuery().queryKey, updated);
    },
  });
  const test = useMutation({
    mutationFn: (values: Values) => testConnection(destinationFields(values, separate)),
  });
  const ids = {
    enabled: React.useId(),
    enabledHint: React.useId(),
    time: React.useId(),
    keep: React.useId(),
    bucket: React.useId(),
    prefix: React.useId(),
    endpoint: React.useId(),
    region: React.useId(),
    accessKey: React.useId(),
    secret: React.useId(),
    secretHint: React.useId(),
  };
  const { values } = form;
  const secret = data.settings.secret;

  return (
    <SettingsSection
      title="Schedule and destination"
      description="When the worker backs up, how long backups are kept, and where they go. Only the owner can view and change this."
      form={form}
      onSave={(submitted) => save.mutate(submitted)}
      saving={save.isPending}
      error={save.error?.message}
      saveLabel="Save backup settings"
      className="border-t"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor={ids.enabled}>Back up every day</Label>
          <p id={ids.enabledHint} className="text-sm text-ink-subtle">
            Turning this on for the first time makes the backup key below. Backups made by backup.sh
            on the server work either way.
          </p>
        </div>
        <Switch
          id={ids.enabled}
          name="enabled"
          aria-describedby={ids.enabledHint}
          checked={values.enabled}
          disabled={save.isPending}
          onCheckedChange={(checked) => form.set("enabled", checked)}
        />
      </div>
      <FieldGroup className="sm:grid sm:grid-cols-2 sm:gap-4">
        <Field>
          <FieldLabel htmlFor={ids.time}>Time of day</FieldLabel>
          <Input
            id={ids.time}
            name="timeOfDay"
            type="time"
            step={60}
            required
            value={values.timeOfDay}
            onChange={(event) => form.set("timeOfDay", event.target.value)}
            className="w-36"
          />
          <FieldDescription>In the instance's timezone, {timeZone}.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor={ids.keep}>Days to keep</FieldLabel>
          <Input
            id={ids.keep}
            name="keepDays"
            type="number"
            inputMode="numeric"
            min={1}
            max={365}
            required
            value={values.keepDays}
            onChange={(event) => form.set("keepDays", event.target.value)}
            className="w-24"
          />
          <FieldDescription>
            Older backups in the folder are deleted after each backup, except the newest whole one.
          </FieldDescription>
        </Field>
      </FieldGroup>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-2 text-sm font-medium text-ink">Destination</legend>
        <DestinationText data={data} />
        <FieldGroup className="sm:grid sm:grid-cols-2 sm:gap-4">
          {separate && (
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor={ids.endpoint}>Endpoint</FieldLabel>
              <Input
                id={ids.endpoint}
                name="endpoint"
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://s3.eu-central-1.amazonaws.com"
                value={values.endpoint}
                onChange={(event) => form.set("endpoint", event.target.value)}
              />
              <FieldDescription>
                The S3 address, without the bucket, such as
                https://&lt;account&gt;.r2.cloudflarestorage.com for R2.
              </FieldDescription>
            </Field>
          )}
          {separate && (
            <Field>
              <FieldLabel htmlFor={ids.region}>Region</FieldLabel>
              <Input
                id={ids.region}
                name="region"
                autoComplete="off"
                spellCheck={false}
                placeholder="us-east-1"
                value={values.region}
                onChange={(event) => form.set("region", event.target.value)}
              />
              <FieldDescription>auto for Cloudflare R2.</FieldDescription>
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor={ids.bucket}>Bucket</FieldLabel>
            <Input
              id={ids.bucket}
              name="bucket"
              autoComplete="off"
              spellCheck={false}
              value={values.bucket}
              onChange={(event) => form.set("bucket", event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={ids.prefix}>Folder</FieldLabel>
            <Input
              id={ids.prefix}
              name="prefix"
              autoComplete="off"
              spellCheck={false}
              required
              value={values.prefix}
              onChange={(event) => form.set("prefix", event.target.value)}
            />
            <FieldDescription>
              Each backup goes in a folder of its own inside it, named by its time in UTC.
            </FieldDescription>
          </Field>
          {separate && (
            <Field>
              <FieldLabel htmlFor={ids.accessKey}>Access key ID</FieldLabel>
              <Input
                id={ids.accessKey}
                name="accessKeyId"
                autoComplete="off"
                spellCheck={false}
                value={values.accessKeyId}
                onChange={(event) => form.set("accessKeyId", event.target.value)}
              />
            </Field>
          )}
          {separate && (
            <Field>
              <FieldLabel htmlFor={ids.secret}>Secret access key</FieldLabel>
              <Input
                id={ids.secret}
                name="secretAccessKey"
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                placeholder={secret === "saved" ? "Saved" : undefined}
                aria-describedby={ids.secretHint}
                value={values.secretAccessKey}
                onChange={(event) => form.set("secretAccessKey", event.target.value)}
              />
              <FieldDescription
                id={ids.secretHint}
                className={secret === "unreadable" ? "text-warning" : undefined}
              >
                {secret === "saved"
                  ? "A secret is saved. It is never shown again: leave this empty to keep it, or type a new one to replace it."
                  : secret === "unreadable"
                    ? "The saved secret can't be read: AUTH_SECRET changed since it was saved. Type it again, and save."
                    : "Stored encrypted on this server, and never shown again after saving."}
              </FieldDescription>
            </Field>
          )}
        </FieldGroup>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              disabled={test.isPending}
              onClick={() => test.mutate(values)}
            >
              {test.isPending ? "Testing…" : "Test connection"}
            </Button>
            <p className="text-sm text-ink-subtle">
              Tries writing, listing, reading, and deleting a small file in the folder, with the
              values above, saved or not.
            </p>
          </div>
          <div aria-live="polite">
            {test.isSuccess && <ConnectionResult result={test.data} />}
            {test.isError && (
              <p role="alert" className="text-sm text-destructive">
                {test.error.message}
              </p>
            )}
          </div>
        </div>
      </fieldset>
    </SettingsSection>
  );
}

/** The key, the reminder, and what losing it means. */
function KeySection({ data, timeZone }: { data: Backups; timeZone: string }) {
  const queryClient = useQueryClient();
  const { key } = data;
  // Fetched only when asked, and kept here while shown: never in the query cache.
  const [shown, setShown] = React.useState<BackupKey | null>(null);
  const setData = (updated: Backups) => queryClient.setQueryData(backupsQuery().queryKey, updated);
  const show = useMutation({ mutationFn: fetchBackupKey, onSuccess: setShown });
  const download = useMutation({
    mutationFn: fetchBackupKeyFile,
    onSuccess: ({ text, fileName }) => {
      const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(url);
    },
  });
  const saved = useMutation({ mutationFn: confirmKeySaved, onSuccess: setData });
  const replace = useMutation({
    mutationFn: replaceKey,
    onSuccess: (updated) => {
      setShown(null);
      setData(updated);
    },
  });
  const failure = show.error ?? download.error ?? saved.error ?? replace.error;

  return (
    <SettingsSection
      title="Backup key"
      description="Every backup is encrypted with this key before it leaves the server, in the age format, so it can also be decrypted without Ottertrail."
      className="border-t"
    >
      {key.state === "none" && (
        <p className="text-sm text-ink-subtle">
          The key is made when you first turn backups on and save. It then shows here, to copy or
          download.
        </p>
      )}
      {key.state === "unreadable" && (
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertTitle>The backup key can't be read</AlertTitle>
          <AlertDescription className="text-pretty">
            The server's AUTH_SECRET changed since the key was made, and the key is stored encrypted
            with it. Backups made with the old key can still be restored with the key file you
            saved. Make a new key to go on backing up; save it as you did the old one.
          </AlertDescription>
          <AlertAction>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={replace.isPending}
              onClick={() => replace.mutate()}
            >
              Make a new key
            </Button>
          </AlertAction>
        </Alert>
      )}
      {key.state === "ready" && (
        <>
          {key.savedAt === null && (
            <Alert>
              <KeyRoundIcon />
              <AlertTitle>Save the backup key somewhere other than this server</AlertTitle>
              <AlertDescription className="flex flex-col gap-2 text-pretty">
                <span>
                  Download it or copy it into a password manager. This server keeps the only other
                  copy, so if the server is lost, the key is lost with it.
                </span>
                <Button
                  type="button"
                  size="sm"
                  className="w-fit"
                  disabled={saved.isPending}
                  onClick={() => saved.mutate()}
                >
                  I've saved the key
                </Button>
              </AlertDescription>
            </Alert>
          )}
          <p className="text-sm font-medium text-pretty text-ink">
            If the server is lost and nobody has the key, the backups can't be read by anyone,
            Ottertrail included, so they can't be restored.
          </p>
          <p className="text-sm text-pretty text-ink-subtle">
            Restoring on a new server takes three things: this key file, the bucket's access key,
            and the old server's AUTH_SECRET. restore.sh --from-s3 asks for the first two.
          </p>
          <dl className="flex flex-col gap-3">
            <StatusRow label="Public key">
              <code className="font-mono text-code [overflow-wrap:anywhere] text-ink">
                {key.recipient}
              </code>
            </StatusRow>
            {key.createdAt !== null && (
              <StatusRow label="Made">{formatMoment(key.createdAt, timeZone)}</StatusRow>
            )}
            {key.savedAt !== null && (
              <StatusRow label="Saved">
                <StatusBadge tone="good">Confirmed</StatusBadge>
                {formatMoment(key.savedAt, timeZone)}
              </StatusRow>
            )}
          </dl>
          {shown !== null && <CopyableCode text={shown.key} copyLabel="Copy the backup key" />}
          <div className="flex flex-wrap items-center gap-2">
            {shown === null ? (
              <Button
                type="button"
                variant="outline"
                disabled={show.isPending}
                onClick={() => show.mutate()}
              >
                <EyeIcon aria-hidden="true" />
                Show key
              </Button>
            ) : (
              <Button type="button" variant="outline" onClick={() => setShown(null)}>
                <EyeOffIcon aria-hidden="true" />
                Hide key
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={download.isPending}
              onClick={() => download.mutate()}
            >
              <DownloadIcon aria-hidden="true" />
              Download key file
            </Button>
          </div>
          <p className="text-sm text-ink-subtle">
            Showing or downloading the key is recorded in the server's log, without the key.
          </p>
        </>
      )}
      {failure !== null && (
        <p role="alert" className="text-sm text-destructive">
          {failure.message}
        </p>
      )}
    </SettingsSection>
  );
}

/**
 * The Backups tab, for the owner. `onDirty` reports unsaved changes to the
 * schedule and destination: the tab's "Unsaved" mark and the leave guard
 * follow it.
 */
export function BackupsTab({ timeZone, onDirty }: InstanceTabProps) {
  const backups = useQuery({
    ...backupsQuery(),
    // While the worker has work under way or asked for, the status follows it.
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status !== undefined &&
        (status.running !== null || status.backupRequested || status.testRestoreRequested)
        ? POLL_MS
        : false;
    },
  });
  if (backups.isPending) return <SectionSkeleton />;
  if (backups.isError && backups.data === undefined) {
    return (
      <SectionFailed
        title="Backups could not load"
        message={backups.error.message}
        retry={() => void backups.refetch()}
      />
    );
  }
  const data = backups.data;
  if (data === undefined) return <SectionSkeleton />;
  return (
    <div className="flex flex-col">
      <StatusSection data={data} timeZone={timeZone} />
      <SettingsForm data={data} timeZone={timeZone} onDirty={onDirty} />
      <KeySection data={data} timeZone={timeZone} />
    </div>
  );
}
