import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRightIcon,
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
  type DestinationConfig,
  fetchBackupKey,
  fetchBackupKeyFile,
  replaceKey,
  testConnection,
  testRestore,
  updateBackups,
} from "@/lib/backups-api";
import { DOCS_URL } from "@/lib/docs";
import { formatBytes } from "@/lib/source-maps-api";

import { formatMoment, formatSpan } from "../uptime/format";
import { type InstanceTabProps, SectionFailed, SectionSkeleton } from "./section-states";

/** Backup destination comes from the worker's BACKUP_S3_* values (docs/dashboard.md, "Backups"). */
const POLL_MS = 5000;

const BACKUPS_DOCS_URL = `${DOCS_URL}/self-hosting/backups/#set-up-scheduled-backups`;

function DocsLink() {
  return (
    <a
      href={BACKUPS_DOCS_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-0.5 text-ink underline underline-offset-4"
    >
      Backups docs
      <ArrowUpRightIcon aria-hidden="true" className="size-3" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

const code = (text: string) => <code className="font-mono">{text}</code>;

const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

const TRIGGER_TEXT: Record<BackupRun["trigger"], string> = {
  schedule: "daily backup",
  manual: "Back up now",
  retry: "retry",
};

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

function StatusRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[10rem_1fr] sm:gap-4">
      <dt className="text-sm text-ink-subtle">{label}</dt>
      <dd className="flex flex-wrap items-center gap-2 text-sm text-ink">{children}</dd>
    </div>
  );
}

function BucketList({ timeZone, listedAt }: { timeZone: string; listedAt: string | null }) {
  // A new listing time means the worker refreshed the bucket contents.
  const list = useQuery({
    queryKey: [...backupListQuery().queryKey, listedAt ?? ""],
    queryFn: backupListQuery().queryFn,
  });
  if (list.isPending) {
    return (
      <p className="text-sm text-ink-subtle" aria-busy="true">
        Loading backups…
      </p>
    );
  }
  if (list.isError) {
    return (
      <Alert variant="destructive">
        <OctagonAlertIcon />
        <AlertTitle>Couldn't load backups</AlertTitle>
        <AlertDescription>{list.error.message}</AlertDescription>
        <AlertAction>
          <Button type="button" variant="outline" size="sm" onClick={() => void list.refetch()}>
            Retry
          </Button>
        </AlertAction>
      </Alert>
    );
  }
  const listed = list.data;
  if (listed.listedAt === null) {
    return <p className="text-sm text-ink-subtle">Not listed yet.</p>;
  }
  const asOf = formatMoment(listed.listedAt, timeZone);
  if (!listed.ok) {
    return (
      <Alert variant="destructive">
        <OctagonAlertIcon />
        <AlertTitle>Couldn't list backups</AlertTitle>
        <AlertDescription className="text-pretty">
          {sentence(listed.error)} As of {asOf}.
        </AlertDescription>
      </Alert>
    );
  }
  const { backups, bucket, prefix } = listed;
  if (backups.length === 0) {
    return (
      <p className="text-sm text-ink-subtle">
        No backups in {bucket}/{prefix} as of {asOf}.
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
                  <StatusBadge tone="good">Complete</StatusBadge>
                ) : (
                  <StatusBadge tone="warning">Incomplete</StatusBadge>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-sm text-ink-subtle">
        In {bucket}/{prefix}, as of {asOf}. Incomplete backups can't be restored.
      </p>
    </div>
  );
}

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
    <SettingsSection title="Backups">
      {off && settings.disabledAt !== null && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-ink">
          <StatusBadge tone="neutral">Off</StatusBadge>
          Off since {formatMoment(settings.disabledAt, timeZone)}, by{" "}
          {settings.disabledBy ?? "someone"}.
        </p>
      )}
      {off && last === null ? (
        settings.disabledAt === null && <p className="text-sm text-ink-subtle">Backups are off.</p>
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
              {running.kind === "backup" ? "Backing up" : "Testing restore"} (
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
          <AlertTitle>Last backup failed</AlertTitle>
          <AlertDescription className="text-pretty">
            {sentence(last.error ?? "No error recorded.")}{" "}
            {status.retryAt !== null
              ? `Retries once at ${formatMoment(status.retryAt, timeZone)}.`
              : ""}
          </AlertDescription>
        </Alert>
      )}
      {status.overdueSince !== null && (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>Backup overdue</AlertTitle>
          <AlertDescription className="text-pretty">
            No successful backup since {formatMoment(status.overdueSince, timeZone)}. Check the
            worker (docker compose ps), or use Back up now.
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
            ? "Backup starts within a minute."
            : status.testRestoreRequested
              ? "Test restore starts within a minute."
              : ""}
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
                Backup {status.lastTestRestore.folder}: decryption and checksums passed.
              </span>
            )}
          </StatusRow>
          {status.lastTestRestore.status === "failed" && (
            <dd className="text-sm text-pretty text-destructive">
              {sentence(status.lastTestRestore.error ?? "No error recorded.")}
            </dd>
          )}
        </dl>
      )}

      {settings.enabled && (
        <section aria-label="Backups in the bucket" className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-ink">In the bucket</h3>
          <BucketList timeZone={timeZone} listedAt={status.listedAt} />
        </section>
      )}
    </SettingsSection>
  );
}

interface Values {
  enabled: boolean;
  timeOfDay: string;
  keepDays: string;
}

function valuesOf(data: Backups): Values {
  const { settings } = data;
  return {
    enabled: settings.enabled,
    timeOfDay: settings.timeOfDay,
    keepDays: String(settings.keepDays),
  };
}

const STEP_TEXT: Record<ConnectionStep["step"], string> = {
  put: "Write a test file",
  list: "List the folder",
  get: "Read the file",
  delete: "Delete the file",
};

function ConnectionResult({ result }: { result: ConnectionTest }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium text-ink">
        {result.ok ? "Connection works." : "Connection failed."}
      </p>
      {result.error !== undefined && (
        <p className="text-sm text-pretty text-destructive">{sentence(result.error)}</p>
      )}
      {result.steps.length > 0 && (
        <ul aria-label="Test connection steps" className="flex flex-col gap-1.5">
          {result.steps.map((step) => (
            <li key={step.step} className="flex flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-2 text-sm text-ink">
                <StatusBadge
                  tone={
                    step.status === "ok"
                      ? "good"
                      : step.status === "failed"
                        ? "critical"
                        : "neutral"
                  }
                >
                  {step.status === "ok"
                    ? "Worked"
                    : step.status === "failed"
                      ? "Failed"
                      : "Skipped"}
                </StatusBadge>
                {STEP_TEXT[step.step]}
              </span>
              {step.error !== undefined && (
                <span className="text-sm text-pretty text-destructive">{step.error}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const DESTINATION_ROWS: [keyof DestinationConfig, string][] = [
  ["endpoint", "Endpoint"],
  ["bucket", "Bucket"],
  ["prefix", "Folder"],
  ["region", "Region"],
  ["accessKeyId", "Access key ID"],
];

function DestinationBlock({ data, timeZone }: { data: Backups; timeZone: string }) {
  const queryClient = useQueryClient();
  const { destination, connectionTest } = data;
  const test = useMutation({
    mutationFn: testConnection,
    onSuccess: (updated) => queryClient.setQueryData(backupsQuery().queryKey, updated),
  });
  const config = destination.config;
  const pending = connectionTest.requested;
  const on = data.settings.enabled;
  const reportedAt =
    destination.reportedAt === null ? null : formatMoment(destination.reportedAt, timeZone);

  return (
    <section aria-label="Destination" className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-ink">Destination</h3>
      {destination.stale && reportedAt !== null && (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>Worker report out of date</AlertTitle>
          <AlertDescription className="text-pretty">
            The worker last reported at {reportedAt}. Check that the worker is running (
            {code("docker compose ps")}).
          </AlertDescription>
        </Alert>
      )}
      {config !== null ? (
        <dl className="flex flex-col gap-3">
          {DESTINATION_ROWS.map(([field, label]) => (
            <StatusRow key={field} label={label}>
              <span className="[overflow-wrap:anywhere]">{config[field]}</span>
            </StatusRow>
          ))}
          {reportedAt !== null && (
            <StatusRow label="Reported">
              <span className="tabular-nums">{reportedAt}</span>
            </StatusRow>
          )}
        </dl>
      ) : destination.problem !== null ? (
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertTitle>Backup destination invalid</AlertTitle>
          <AlertDescription className="text-pretty">
            {sentence(destination.problem)} Then restart the worker.
            {on && " Until then, backups fail."}
          </AlertDescription>
        </Alert>
      ) : on ? (
        // Enabled backups fail if the worker restarts without destination variables.
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertTitle>Backups have no destination</AlertTitle>
          <AlertDescription className="text-pretty">
            Backups are on, but the worker has no {code("BACKUP_S3_*")} variables, so the next
            backup fails. Set them in the server&apos;s {code(".env")} and restart the worker.{" "}
            <DocsLink />
          </AlertDescription>
        </Alert>
      ) : (
        <p className="text-sm text-pretty text-ink-subtle">
          Set the {code("BACKUP_S3_*")} variables in the server&apos;s {code(".env")} and restart
          the worker. <DocsLink />
        </p>
      )}
      {config !== null && (
        <div className="flex flex-col gap-3">
          <div>
            <Button
              type="button"
              variant="outline"
              disabled={test.isPending || pending}
              onClick={() => test.mutate()}
            >
              {pending ? "Testing…" : "Test connection"}
            </Button>
          </div>
          <div aria-live="polite" className="flex flex-col gap-2">
            {pending ? (
              <p className="text-sm text-ink-subtle">Test connection starts within a minute.</p>
            ) : connectionTest.untaken ? (
              <p className="text-sm text-pretty text-warning">
                The worker hasn&apos;t taken the test. Check that it is running (
                {code("docker compose ps")}), then test again.
              </p>
            ) : (
              connectionTest.result !== null && (
                <>
                  <ConnectionResult result={connectionTest.result} />
                  {connectionTest.testedAt !== null && (
                    <p className="text-sm text-ink-subtle">
                      Tested {formatMoment(connectionTest.testedAt, timeZone)}.
                    </p>
                  )}
                </>
              )
            )}
            {test.isError && (
              <p role="alert" className="text-sm text-destructive">
                {test.error.message}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

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
    normalize: { keepDays: (days) => Number(days) },
  });
  React.useEffect(() => onDirty(form.dirty), [onDirty, form.dirty]);
  // Confirmation text is never saved; clear it after disabling.
  const [password, setPassword] = React.useState("");
  const turningOff = form.initial.enabled && !form.values.enabled;
  const save = useMutation({
    mutationFn: (values: Values) => {
      const changes: BackupChanges = {
        enabled: values.enabled,
        timeOfDay: values.timeOfDay,
        keepDays: Number(values.keepDays),
        ...(turningOff ? { currentPassword: password } : {}),
      };
      return updateBackups(changes);
    },
    onSuccess: (updated, values) => {
      setPassword("");
      form.saved(values);
      queryClient.setQueryData(backupsQuery().queryKey, updated);
    },
  });
  const ids = {
    enabled: React.useId(),
    time: React.useId(),
    keep: React.useId(),
    password: React.useId(),
  };
  const { values } = form;
  // Enabling requires a destination reported by the worker.
  const destinationReady = data.destination.config !== null && data.destination.problem === null;

  return (
    <SettingsSection
      title="Schedule and destination"
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
        </div>
        <Switch
          id={ids.enabled}
          name="enabled"
          checked={values.enabled}
          disabled={save.isPending || (!form.initial.enabled && !destinationReady)}
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
          <FieldDescription>{timeZone}</FieldDescription>
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
          <FieldDescription>Older backups are deleted, except the newest one.</FieldDescription>
        </Field>
      </FieldGroup>
      {turningOff && (
        <Field>
          <FieldLabel htmlFor={ids.password}>Current password</FieldLabel>
          <Input
            id={ids.password}
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="max-w-72"
          />
        </Field>
      )}
      <DestinationBlock data={data} timeZone={timeZone} />
    </SettingsSection>
  );
}

function KeySection({ data, timeZone }: { data: Backups; timeZone: string }) {
  const queryClient = useQueryClient();
  const { key } = data;
  // Fetch the key on demand and keep it out of the query cache.
  const [shown, setShown] = React.useState<BackupKey | null>(null);
  // Clear the password after showing or downloading the key.
  const [password, setPassword] = React.useState("");
  const passwordId = React.useId();
  const setData = (updated: Backups) => queryClient.setQueryData(backupsQuery().queryKey, updated);
  const show = useMutation({
    mutationFn: fetchBackupKey,
    onSuccess: (fetched) => {
      setPassword("");
      setShown(fetched);
    },
  });
  const download = useMutation({
    mutationFn: fetchBackupKeyFile,
    onSuccess: ({ text, fileName }) => {
      setPassword("");
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
    <SettingsSection title="Backup key" className="border-t">
      {key.state === "none" && (
        <p className="text-sm text-ink-subtle">Turn on backups to create a key.</p>
      )}
      {key.state === "unreadable" && (
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertTitle>Can't read backup key</AlertTitle>
          <AlertDescription className="text-pretty">
            AUTH_SECRET changed. Older backups need your saved key file.
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
              <AlertTitle>Save the key off this server</AlertTitle>
              <AlertDescription className="flex flex-col gap-2 text-pretty">
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
            Backups can't be restored if the server and key are lost.
          </p>
          <p className="text-sm text-pretty text-ink-subtle">
            A restore needs the key file, the bucket's access key, and the server's AUTH_SECRET.
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
          <Field>
            <FieldLabel htmlFor={passwordId}>Current password</FieldLabel>
            <Input
              id={passwordId}
              name="keyPassword"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="max-w-72"
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            {shown === null ? (
              <Button
                type="button"
                variant="outline"
                disabled={show.isPending || password === ""}
                onClick={() => show.mutate(password)}
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
              disabled={download.isPending || password === ""}
              onClick={() => download.mutate(password)}
            >
              <DownloadIcon aria-hidden="true" />
              Download key file
            </Button>
          </div>
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

/** `onDirty` drives the Unsaved mark and leave guard for the schedule. */
export function BackupsTab({ timeZone, onDirty }: InstanceTabProps) {
  const backups = useQuery({
    ...backupsQuery(),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status !== undefined &&
        (status.running !== null ||
          status.backupRequested ||
          status.testRestoreRequested ||
          query.state.data?.connectionTest.requested === true)
        ? POLL_MS
        : false;
    },
  });
  if (backups.isPending) return <SectionSkeleton />;
  if (backups.isError && backups.data === undefined) {
    return (
      <SectionFailed
        title="Couldn't load backups"
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
