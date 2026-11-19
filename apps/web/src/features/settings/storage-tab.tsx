import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { InfoIcon, OctagonAlertIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import * as React from "react";

import { Missing } from "@/components/missing";
import { SettingsSection } from "@/components/settings-section";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ignoreOrder, useDirtyForm } from "@/hooks/use-dirty-form";
import { formatBytes } from "@/lib/source-maps-api";
import {
  type Retention,
  type StorageReport,
  storageQuery,
  updateWarningChannels,
  type WarningChannels,
} from "@/lib/storage-api";
import { cn } from "@/lib/utils";

import { formatMoment } from "../uptime/format";
import { type InstanceTabProps, SectionFailed, SectionSkeleton } from "./section-states";

/**
 * The Storage tab of the instance's Settings (docs/deployment.md,
 * "Storage"; GET /api/settings/storage): the warnings first, then the
 * disk and what fills it, one row per store, and the channels that get
 * storage warnings. For the owner and admins. Self-contained: its own
 * query, and the instance's timezone as a prop.
 */

/** "46%": a share, rounded down below 100, never "100%" while something is left. */
function percent(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  const share = (part / whole) * 100;
  if (share > 0 && share < 1) return "under 1%";
  return `${Math.min(Math.floor(share), part < whole ? 99 : 100)}%`;
}

const code = (text: string) => <code className="font-mono text-code text-ink">{text}</code>;

/** How long a ClickHouse table keeps its rows, in words. */
function retentionText(retention: Retention): string {
  if (retention.kind === "days") return `Kept ${retention.days} days.`;
  if (retention.kind === "with_events") return "Kept with the project's events.";
  if (retention.kind === "none") return "Small; not deleted on a schedule.";
  const forever = retention.keptForever ?? 0;
  return forever === 0
    ? "Kept as long as each project's retention says."
    : `Kept as long as each project's retention says. ${forever} ${forever === 1 ? "project keeps" : "projects keep"} events forever: set a retention in its settings to limit them.`;
}

/** What the API's table names mean. */
const TABLE_NAMES: Record<string, string> = {
  events: "Events and errors",
  spans: "Traces",
  logs: "Logs",
  metric_points: "Metrics",
  metric_histograms: "Metric histograms",
  check_results: "Uptime check results",
  heatmaps: "Heatmaps",
  user_first_seen: "First seen per user",
  schema_migrations: "Schema versions",
};

/** One bar against a limit: the used part filled, the rest the track, both in the blue ramp. */
function Meter({ used, limit, label }: { used: number; limit: number; label: string }) {
  const share = limit <= 0 ? 0 : Math.min(1, used / limit);
  return (
    <div data-slot="storage-meter" className="relative">
      {/* The meter for assistive technology; the bar below draws it, alike in every browser. */}
      <meter
        aria-label={label}
        min={0}
        max={limit}
        value={Math.min(used, limit)}
        aria-valuetext={`${formatBytes(used)} of ${formatBytes(limit)} (${percent(used, limit)})`}
        className="sr-only"
      />
      <div aria-hidden="true" className="h-2 w-full overflow-hidden rounded-full bg-seq-1">
        <div
          className="h-full rounded-full bg-chart-1"
          style={{ width: `${share * 100}%`, minWidth: used > 0 ? "2px" : 0 }}
        />
      </div>
    </div>
  );
}

/** A part of the disk: what fills it, in the categorical order, then the rest in gray. */
interface DiskPart {
  key: string;
  name: string;
  bytes: number;
  /** A Tailwind background class: chart-1 to chart-3 for the stores, gray for the rest. */
  fill: string;
}

/** The figure a row shows: its amount, or what is missing in words. */
function Figure({ bytes, missing }: { bytes: number | null; missing: string }) {
  return bytes === null ? <Missing label={missing} /> : <>{formatBytes(bytes)}</>;
}

/**
 * One store: its name and state, the four figures (used, limit, left,
 * share of the disk), an optional bar, and a note on what the figure
 * measures.
 */
function StoreRow({
  name,
  swatch,
  badge,
  used,
  limit,
  left,
  share,
  bar,
  children,
}: {
  name: string;
  swatch?: string | undefined;
  badge?: React.ReactNode;
  used: React.ReactNode;
  limit: React.ReactNode;
  left: React.ReactNode;
  share: React.ReactNode;
  bar?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const id = React.useId();
  return (
    <li aria-labelledby={id} className="flex flex-col gap-2 border-t py-3 first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {swatch !== undefined && (
          <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", swatch)} />
        )}
        <h3 id={id} className="text-sm font-medium text-ink">
          {name}
        </h3>
        {badge}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        {(
          [
            ["Used", used],
            ["Limit", limit],
            ["Left", left],
            ["Share of the disk", share],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="flex flex-col">
            <dt className="text-xs text-ink-subtle">{label}</dt>
            <dd className="text-ink tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {bar}
      {children !== undefined && <div className="text-sm text-ink-subtle">{children}</div>}
    </li>
  );
}

/** The stores' bytes on the disk, and the disk's free space, as one thin segmented bar. */
function DiskBar({ parts, total }: { parts: DiskPart[]; total: number }) {
  const shown = parts.filter((part) => part.bytes > 0);
  const text = `The disk, ${formatBytes(total)}: ${parts
    .map((part) => `${part.name} ${formatBytes(part.bytes)} (${percent(part.bytes, total)})`)
    .join("; ")}`;
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={text}
        data-slot="disk-bar"
        className="flex h-2 w-full cursor-default gap-0.5 rounded-full outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
      >
        {shown.map((part) => (
          <span
            key={part.key}
            data-part={part.key}
            className={cn("h-full min-w-0.5 rounded-full", part.fill)}
            style={{ flexGrow: part.bytes, flexBasis: 0 }}
          />
        ))}
      </TooltipTrigger>
      <TooltipContent>
        <ul className="flex flex-col gap-1">
          {parts.map((part) => (
            <li key={part.key} className="flex items-center gap-2">
              <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", part.fill)} />
              <span className="font-semibold tabular-nums">{formatBytes(part.bytes)}</span>
              <span>
                {part.name} ({percent(part.bytes, total)})
              </span>
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

/** What the undetermined warnings are about, in words. */
const UNDETERMINED_TEXT: Record<string, string> = {
  merge_headroom: "room to merge",
  backup_space: "room for a backup",
  disk_used: "how full the disk is",
  replay_budget: "the replay budget",
  source_map_budget: "the source map budget",
  budgets_exceed_disk: "whether the budgets fit the disk",
};

/**
 * The warnings on now; those on when last measured that could not be
 * measured now ("still on"); and "No warnings" only when every figure was
 * measured.
 */
function Warnings({ report }: { report: StorageReport }) {
  const { warnings, held, undetermined, objectStore } = report;
  const unheld = undetermined.filter((id) => !held.some((warning) => warning.id === id));
  if (warnings.length === 0 && held.length === 0) {
    if (undetermined.length > 0) {
      return (
        <p className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
          <StatusBadge tone="warning">Not checked</StatusBadge>
          Some figures could not be measured, so these were not checked:{" "}
          {unheld.map((id) => UNDETERMINED_TEXT[id] ?? id).join(", ")}.
        </p>
      );
    }
    return (
      <p className="flex items-center gap-2 text-sm text-ink-muted">
        <StatusBadge tone="good">No warnings</StatusBadge>
        {objectStore === "none"
          ? "The disk has room."
          : "The disk has room, and the budgets are below 90%."}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <ul aria-label="Storage warnings" className="flex flex-col gap-2">
        {warnings.map((warning) => (
          <li key={warning.id}>
            <Alert
              role={undefined}
              variant={warning.level === "critical" ? "destructive" : "default"}
              data-warning={warning.id}
            >
              {warning.level === "critical" ? <OctagonAlertIcon /> : <TriangleAlertIcon />}
              <AlertTitle className="flex flex-wrap items-center gap-2">
                <StatusBadge tone={warning.level === "critical" ? "critical" : "warning"}>
                  {warning.level === "critical" ? "Critical" : "Warning"}
                </StatusBadge>
                {warning.title}
              </AlertTitle>
              <AlertDescription className="text-pretty">{warning.text}</AlertDescription>
            </Alert>
          </li>
        ))}
        {held.map((warning) => (
          <li key={warning.id}>
            <Alert
              role={undefined}
              variant={warning.level === "critical" ? "destructive" : "default"}
              data-warning={warning.id}
              data-held=""
            >
              {warning.level === "critical" ? <OctagonAlertIcon /> : <TriangleAlertIcon />}
              <AlertTitle className="flex flex-wrap items-center gap-2">
                <StatusBadge tone={warning.level === "critical" ? "critical" : "warning"}>
                  {warning.level === "critical" ? "Critical" : "Warning"}
                </StatusBadge>
                {warning.title}
              </AlertTitle>
              <AlertDescription className="text-pretty">
                Still on: it was on when last measured, and could not be measured now. The rows
                below say what failed.
              </AlertDescription>
            </Alert>
          </li>
        ))}
      </ul>
      {unheld.length > 0 && (
        <p className="text-sm text-ink-muted">
          Not checked, as their figures could not be measured:{" "}
          {unheld.map((id) => UNDETERMINED_TEXT[id] ?? id).join(", ")}.
        </p>
      )}
    </div>
  );
}

/** "Could not measure" with the reason: never 0 bytes, never an old figure. */
function Unmeasured({ error }: { error: string }) {
  return (
    <p className="text-sm [overflow-wrap:anywhere] text-ink-muted">Could not measure: {error}</p>
  );
}

const unmeasuredBadge = <StatusBadge tone="warning">Could not measure</StatusBadge>;

function Stores({ report }: { report: StorageReport }) {
  const { disk, budgets, clickhouse, postgres, garage, objectStore } = report;
  const total = disk.ok ? disk.totalBytes : null;
  const share = (bytes: number | null) =>
    bytes === null || total === null ? <Missing label="Not measured" /> : percent(bytes, total);

  // The objects on this disk: only with the stack's Garage. Garage's own count when it has one.
  const recordedObjects =
    budgets?.ok === true ? budgets.replays.usedBytes + budgets.sourceMaps.usedBytes : null;
  const garageBytes = garage?.state === "ok" ? (garage.bucket?.bytes ?? null) : null;
  const objectsOnDisk = objectStore === "garage" ? (garageBytes ?? recordedObjects) : null;

  const parts: DiskPart[] = [];
  if (disk.ok) {
    const used = disk.totalBytes - disk.freeBytes;
    if (clickhouse.ok) {
      parts.push({
        key: "clickhouse",
        name: "ClickHouse",
        bytes: clickhouse.totalBytes,
        fill: "bg-chart-1",
      });
    }
    if (postgres.ok) {
      parts.push({
        key: "postgres",
        name: "PostgreSQL",
        bytes: postgres.databaseBytes,
        fill: "bg-chart-2",
      });
    }
    if (objectsOnDisk !== null) {
      parts.push({
        key: "objects",
        name: "Replays and source maps (Garage)",
        bytes: objectsOnDisk,
        fill: "bg-chart-3",
      });
    }
    const known = parts.reduce((sum, part) => sum + part.bytes, 0);
    parts.push({
      key: "other",
      name: "Everything else (the system, images, backups, logs)",
      bytes: Math.max(0, used - known),
      fill: "bg-ink-tertiary",
    });
    parts.push({ key: "free", name: "Free", bytes: disk.freeBytes, fill: "bg-hairline" });
  }

  const budgetRow = (
    name: string,
    key: "replays" | "sourceMaps",
    setting: string,
    warningId: "replay_budget" | "source_map_budget",
  ) => {
    if (budgets === null) {
      return (
        <StoreRow
          name={name}
          badge={<StatusBadge tone="neutral">Off</StatusBadge>}
          used={<Missing label="Off" />}
          limit={<Missing label="Off" />}
          left={<Missing label="Off" />}
          share={<Missing label="Off" />}
        >
          Off: no object store is set up ({code("OBJECT_STORE_URL")}).
        </StoreRow>
      );
    }
    if (!budgets.ok) {
      return (
        <StoreRow
          name={name}
          badge={unmeasuredBadge}
          used={<Missing label="Not measured" />}
          limit={<Missing label="Not measured" />}
          left={<Missing label="Not measured" />}
          share={<Missing label="Not measured" />}
        >
          <Unmeasured error={budgets.error} />
        </StoreRow>
      );
    }
    const budget = budgets[key];
    // The warning's own state, which stays on down to 88%.
    const warned = report.warnings.some((warning) => warning.id === warningId);
    return (
      <StoreRow
        name={name}
        badge={
          warned ? (
            <StatusBadge tone="warning">
              {percent(budget.usedBytes, budget.limitBytes)} of the budget
            </StatusBadge>
          ) : undefined
        }
        used={formatBytes(budget.usedBytes)}
        limit={formatBytes(budget.limitBytes)}
        left={formatBytes(Math.max(0, budget.limitBytes - budget.usedBytes))}
        share={
          objectStore === "garage" ? share(budget.usedBytes) : <Missing label="Not on this disk" />
        }
        bar={
          <Meter
            used={budget.usedBytes}
            limit={budget.limitBytes}
            label={`${name}, used of the budget`}
          />
        }
      >
        Compressed, as recorded by Ottertrail, against {code(setting)}.{" "}
        {objectStore === "other"
          ? "The object store is outside this server, so the budget limits cost, not this disk."
          : "Garage keeps them on this disk."}
      </StoreRow>
    );
  };

  return (
    <ul aria-label="Stores" className="flex flex-col">
      {disk.ok ? (
        <StoreRow
          name="The disk"
          badge={
            disk.readOnly || disk.broken ? (
              <StatusBadge tone="critical">{disk.broken ? "Broken" : "Read-only"}</StatusBadge>
            ) : undefined
          }
          used={formatBytes(disk.totalBytes - disk.freeBytes)}
          limit={formatBytes(disk.totalBytes)}
          left={formatBytes(disk.freeBytes)}
          share={percent(disk.totalBytes - disk.freeBytes, disk.totalBytes)}
          bar={
            <div className="flex flex-col gap-2">
              <Meter
                used={disk.totalBytes - disk.freeBytes}
                limit={disk.totalBytes}
                label="The disk, used of its size"
              />
              <DiskBar parts={parts} total={disk.totalBytes} />
              <ul
                aria-label="What fills the disk"
                className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted"
              >
                {parts.map((part) => (
                  <li key={part.key} className="flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className={cn("size-2 shrink-0 rounded-full", part.fill)}
                    />
                    {part.name}
                  </li>
                ))}
              </ul>
            </div>
          }
        >
          Free for the databases, as ClickHouse measures its data folder (statvfs). PostgreSQL,
          ClickHouse, Garage, and backups share this disk in the default install.
        </StoreRow>
      ) : (
        <StoreRow
          name="The disk"
          badge={unmeasuredBadge}
          used={<Missing label="Not measured" />}
          limit={<Missing label="Not measured" />}
          left={<Missing label="Not measured" />}
          share={<Missing label="Not measured" />}
        >
          <Unmeasured error={disk.error} />
          <p>ClickHouse measures the disk. While it does not answer, collection answers 503 too.</p>
        </StoreRow>
      )}

      {clickhouse.ok ? (
        <StoreRow
          name="ClickHouse"
          swatch="bg-chart-1"
          used={formatBytes(clickhouse.totalBytes)}
          limit={<Missing label="No limit of its own: the disk" />}
          left={<Missing label="See the disk" />}
          share={share(clickhouse.totalBytes)}
        >
          <p>On disk: events, errors, traces, logs, metrics, and uptime results.</p>
          {clickhouse.tables.length === 0 ? (
            <p>No data yet.</p>
          ) : (
            <ul aria-label="ClickHouse tables" className="mt-1 flex flex-col gap-1">
              {clickhouse.tables.map((table) => (
                <li
                  key={table.name}
                  className="flex flex-col sm:grid sm:grid-cols-[14rem_1fr] sm:gap-2"
                >
                  <span className="text-ink">
                    {TABLE_NAMES[table.name] ?? table.name}:{" "}
                    <span className="tabular-nums">{formatBytes(table.bytes)}</span>.
                  </span>
                  <span>{retentionText(table.retention)}</span>
                </li>
              ))}
            </ul>
          )}
        </StoreRow>
      ) : (
        <StoreRow
          name="ClickHouse"
          swatch="bg-chart-1"
          badge={unmeasuredBadge}
          used={<Missing label="Not measured" />}
          limit={<Missing label="No limit of its own: the disk" />}
          left={<Missing label="See the disk" />}
          share={<Missing label="Not measured" />}
        >
          <Unmeasured error={clickhouse.error} />
        </StoreRow>
      )}

      {postgres.ok ? (
        <StoreRow
          name="PostgreSQL"
          swatch="bg-chart-2"
          used={formatBytes(postgres.databaseBytes)}
          limit={<Missing label="No limit of its own: the disk" />}
          left={<Missing label="See the disk" />}
          share={share(postgres.databaseBytes)}
        >
          <p>
            Accounts, projects, settings, alerts, and replays waiting to be joined. Largest tables:
          </p>
          <ul aria-label="PostgreSQL tables" className="mt-1 flex flex-col gap-1">
            {postgres.tables.map((table) => (
              <li key={table.name}>
                <span className="font-mono text-code text-ink">{table.name}</span>:{" "}
                <span className="tabular-nums">{formatBytes(table.bytes)}</span>
              </li>
            ))}
          </ul>
        </StoreRow>
      ) : (
        <StoreRow
          name="PostgreSQL"
          swatch="bg-chart-2"
          badge={unmeasuredBadge}
          used={<Missing label="Not measured" />}
          limit={<Missing label="No limit of its own: the disk" />}
          left={<Missing label="See the disk" />}
          share={<Missing label="Not measured" />}
        >
          <Unmeasured error={postgres.error} />
        </StoreRow>
      )}

      {budgetRow("Session replays", "replays", "REPLAY_STORAGE_BYTES", "replay_budget")}
      {budgetRow("Source maps", "sourceMaps", "SOURCE_MAP_STORAGE_BYTES", "source_map_budget")}

      {garage !== null && <GarageRow report={report} share={share} />}
    </ul>
  );
}

function GarageRow({
  report,
  share,
}: {
  report: StorageReport;
  share: (bytes: number | null) => React.ReactNode;
}) {
  const garage = report.garage;
  if (garage === null) return null;
  if (garage.state === "no_token") {
    return (
      <StoreRow
        name="Garage"
        swatch="bg-chart-3"
        badge={<StatusBadge tone="neutral">Not available</StatusBadge>}
        used={<Missing label="Not available" />}
        limit={<Missing label="Not available" />}
        left={<Missing label="Not available" />}
        share={<Missing label="Not available" />}
      >
        <Alert role={undefined} data-slot="garage-unavailable">
          <InfoIcon />
          <AlertTitle>Garage's real usage is not available</AlertTitle>
          <AlertDescription>{garage.message}</AlertDescription>
        </Alert>
      </StoreRow>
    );
  }
  if (garage.state === "failed") {
    return (
      <StoreRow
        name="Garage"
        swatch="bg-chart-3"
        badge={unmeasuredBadge}
        used={<Missing label="Not measured" />}
        limit={<Missing label="Not measured" />}
        left={<Missing label="Not measured" />}
        share={<Missing label="Not measured" />}
      >
        <Unmeasured error={garage.error} />
      </StoreRow>
    );
  }
  const { bucket, dataPartition, plannedQuotaBytes, quotaAboveBudgets } = garage;
  return (
    <StoreRow
      name="Garage"
      swatch="bg-chart-3"
      used={<Figure bytes={bucket?.bytes ?? null} missing="No bucket" />}
      limit={<Figure bytes={bucket?.quotaBytes ?? null} missing="No quota yet" />}
      left={<Figure bytes={dataPartition?.availableBytes ?? null} missing="Not reported" />}
      share={share(bucket?.bytes ?? null)}
    >
      {bucket === null ? (
        <p>Garage has no bucket of this name: replays and source maps cannot be stored.</p>
      ) : (
        <p>
          The bucket holds {bucket.objects.toLocaleString("en")}{" "}
          {bucket.objects === 1 ? "object" : "objects"}, as Garage counts them. Its quota (
          {formatBytes(plannedQuotaBytes)}), a backstop the worker keeps, refuses writes past it.{" "}
          {quotaAboveBudgets
            ? "It sits above the budgets plus 10%: the bucket holds more than the budgets allow (a budget was lowered), so the quota leaves room for writes within the budgets until old replays expire."
            : "It is the budgets plus 10%."}
          {dataPartition !== null &&
            ` Left is what Garage's data partition has free, of ${formatBytes(dataPartition.totalBytes)}.`}
        </p>
      )}
    </StoreRow>
  );
}

/** The channels that get storage warnings, saved with the section's Save (the save rule). */
function WarningChannelsSection({
  value,
  onDirty,
}: {
  value: WarningChannels;
  onDirty: (dirty: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const form = useDirtyForm(
    { channelIds: value.channelIds },
    { normalize: { channelIds: ignoreOrder } },
  );
  React.useEffect(() => onDirty(form.dirty), [onDirty, form.dirty]);
  const existing = (ids: string[]) =>
    ids.filter((id) => value.channels.some((channel) => channel.id === id));
  // A channel deleted in the channels card leaves the choice too, saved or not.
  const { setValues } = form;
  React.useEffect(() => {
    setValues((previous) => {
      const kept = previous.channelIds.filter((id) =>
        value.channels.some((channel) => channel.id === id),
      );
      return kept.length === previous.channelIds.length ? previous : { channelIds: kept };
    });
  }, [setValues, value.channels]);
  const save = useMutation({
    // A chosen channel deleted since drops out rather than refuse the save.
    mutationFn: (values: { channelIds: string[] }) =>
      updateWarningChannels(existing(values.channelIds)),
    onSuccess: (updated, values) => {
      form.saved({ channelIds: existing(values.channelIds) });
      queryClient.setQueryData(storageQuery().queryKey, (previous) =>
        previous === undefined ? previous : { ...previous, warningChannels: updated },
      );
    },
  });
  const chosen = form.values.channelIds;
  return (
    <SettingsSection
      title="Storage warnings"
      description="The worker checks every 5 minutes. The chosen channels hear when a warning starts, when it becomes critical, and when it ends. None are chosen at first."
      form={form}
      onSave={(values) => save.mutate(values)}
      saving={save.isPending}
      error={save.error?.message}
      saveLabel="Save storage warnings"
      className="border-t"
    >
      {value.channels.length === 0 ? (
        <p className="text-sm text-ink-subtle">
          This instance has no notification channels. Add one under Notification channels, then
          choose it here.
        </p>
      ) : (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium text-ink">Send storage warnings to</legend>
          {value.channels.map((channel) => {
            const id = `storage-channel-${channel.id}`;
            return (
              <Field orientation="horizontal" key={channel.id}>
                <Checkbox
                  id={id}
                  checked={chosen.includes(channel.id)}
                  disabled={save.isPending}
                  onCheckedChange={(next) =>
                    form.set(
                      "channelIds",
                      next ? [...chosen, channel.id] : chosen.filter((item) => item !== channel.id),
                    )
                  }
                />
                <FieldLabel htmlFor={id} className="font-normal">
                  {channel.name}
                  <span className="text-ink-subtle">
                    {channel.kind === "email" ? " (email)" : " (webhook)"}
                  </span>
                </FieldLabel>
              </Field>
            );
          })}
        </fieldset>
      )}
    </SettingsSection>
  );
}

/**
 * The Storage tab of the instance's Settings (`?tab=storage`), for the
 * owner and admins. `onDirty` reports unsaved changes to the channels: the
 * tab's "Unsaved" mark and the leave guard follow it.
 */
export function StorageTab({ timeZone, onDirty }: InstanceTabProps) {
  const storage = useQuery(storageQuery());

  if (storage.isPending) return <SectionSkeleton />;
  if (storage.isError && storage.data === undefined) {
    return (
      <SectionFailed
        title="Storage could not load"
        message={storage.error.message}
        retry={() => void storage.refetch()}
      />
    );
  }
  const report = storage.data;
  if (report === undefined) return <SectionSkeleton />;
  const refreshing = storage.isFetching;
  const refreshFailed = storage.isError;
  return (
    <div className="flex flex-col">
      <SettingsSection
        title="What fills the disk"
        description="What fills the server's disk, and what limits it. Each store is measured on its own when the page opens."
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="mr-auto text-sm text-ink-subtle">
            Measured {formatMoment(report.measuredAt, timeZone)}.
          </p>
          {refreshFailed && (
            <StatusBadge tone="warning">
              Measuring again failed: these figures are older
            </StatusBadge>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={refreshing}
            onClick={() => void storage.refetch()}
          >
            <RefreshCwIcon aria-hidden="true" className={cn(refreshing && "animate-spin")} />
            {refreshing ? "Measuring…" : "Measure again"}
          </Button>
        </div>
        <div
          className={cn("flex flex-col gap-6", (refreshing || refreshFailed) && "opacity-60")}
          aria-busy={refreshing || undefined}
        >
          <Warnings report={report} />
          <Stores report={report} />
        </div>
      </SettingsSection>
      <WarningChannelsSection value={report.warningChannels} onDirty={onDirty} />
    </div>
  );
}
