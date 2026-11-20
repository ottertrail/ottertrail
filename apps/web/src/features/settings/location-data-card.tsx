import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { SettingsSection } from "@/components/settings-section";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useDirtyForm } from "@/hooks/use-dirty-form";
import {
  type LocationDataStatus,
  type LocationDataUpdate,
  locationDataQuery,
  type Settings,
  settingsQuery,
  updateSettings,
} from "@/lib/settings-api";

import { formatMoment } from "../uptime/format";
import { type InstanceTabProps, SectionFailed, SectionSkeleton } from "./section-states";

/** "1 Nov 2026": a file's build or download date, in the instance's timezone. */
function formatDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(iso));
}

/** An error as a sentence: the API's messages end without a full stop. */
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** Whether the latest attempt failed: it came after the last success, or nothing has worked yet. */
const latestFailed = (update: LocationDataUpdate) =>
  update.lastError !== null &&
  (update.lastSuccessAt === null || update.lastAttemptAt > update.lastSuccessAt);

/** How long after a download the API may take to load it: it looks every 10 minutes. */
const LOAD_GRACE_MS = 15 * 60 * 1000;

/** One file's state, from what the API loaded and what the last update did. */
interface FileState {
  /** What the API has loaded, as a short description; null when nothing. */
  loaded: string | null;
  /** When the loaded file was written; null when unknown or nothing is loaded. */
  loadedModifiedAt: string | null;
  loadError: string | null;
  update: LocationDataUpdate | null;
}

/**
 * Whether the last update's file is newer than what the API loaded: the
 * API has not loaded it yet ("waiting", within LOAD_GRACE_MS of the
 * download), or did not ("stuck").
 */
function apiLag(file: FileState, now: number): "none" | "waiting" | "stuck" {
  const { update } = file;
  if (update === null || update.lastSuccessAt === null || update.fileModifiedAt === null) {
    return "none";
  }
  const newer =
    file.loaded === null ||
    file.loadedModifiedAt === null ||
    update.fileModifiedAt > file.loadedModifiedAt;
  if (!newer) return "none";
  return now - Date.parse(update.lastSuccessAt) <= LOAD_GRACE_MS ? "waiting" : "stuck";
}

/**
 * What the API has (or lacks), and what happens next: `consequence` is
 * what the instance does without the file.
 */
function stateText(
  file: FileState,
  consequence: string,
  automatic: boolean,
  timeZone: string,
  now: number,
): string[] {
  const lines: string[] = [];
  const lag = apiLag(file, now);
  if (file.loaded === null) {
    lines.push(consequence);
  }
  const downloaded =
    file.update === null || file.update.lastSuccessAt === null
      ? ""
      : formatMoment(file.update.lastSuccessAt, timeZone);
  if (lag === "waiting") {
    lines.push(
      `A new file was downloaded on ${downloaded}, and the API loads it within 10 minutes.`,
    );
  } else if (lag === "stuck") {
    lines.push(
      file.loadError === null
        ? `The API has not loaded the file downloaded on ${downloaded}. Check that the API and the worker share the location data folder (the geo-data volume).`
        : `The API has not loaded the file downloaded on ${downloaded}: ${sentence(file.loadError)}`,
    );
  } else if (file.loadError !== null) {
    lines.push(
      `The API could not load the last new file, and kept the one before: ${sentence(file.loadError)}`,
    );
  } else if (file.loaded === null && !automatic) {
    lines.push("Automatic updates are off: run update-geo.mjs to download it.");
  } else if (file.loaded === null && file.update === null) {
    lines.push(
      "The worker downloads it within a minute or two, and the API loads it within 10 minutes.",
    );
  }
  return lines;
}

/** One file: what is loaded, when it was last updated, and the last error. */
function FileStatus({
  title,
  file,
  consequence,
  automatic,
  timeZone,
  now,
  credit,
}: {
  title: string;
  file: FileState;
  consequence: string;
  automatic: boolean;
  timeZone: string;
  /** The server's time in its answer: what "15 minutes ago" counts from, whatever the browser's clock says. */
  now: number;
  credit?: React.ReactNode;
}) {
  const { update } = file;
  const failed = update !== null && latestFailed(update);
  const lag = apiLag(file, now);
  const [tone, state]: [StatusTone, string] =
    file.loaded === null
      ? ["critical", "Missing"]
      : failed
        ? ["warning", "Update failed"]
        : lag === "stuck" || file.loadError !== null
          ? ["warning", "Not loaded"]
          : ["good", "Loaded"];
  return (
    <section className="flex flex-col gap-2 border-t pt-4" aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-ink">{title}</h3>
        <StatusBadge tone={tone}>{state}</StatusBadge>
      </div>
      {file.loaded !== null && (
        <p className="text-sm text-muted-foreground">
          {file.loaded}
          {credit}
        </p>
      )}
      {stateText(file, consequence, automatic, timeZone, now).map((line) => (
        <p
          key={line}
          className={
            lag === "stuck" || (file.loadError !== null && line.includes(file.loadError))
              ? "text-sm [overflow-wrap:anywhere] text-warning"
              : "text-sm text-muted-foreground"
          }
        >
          {line}
        </p>
      ))}
      {update !== null && update.lastSuccessAt !== null && (
        <p className="text-sm text-muted-foreground">
          Last updated {formatMoment(update.lastSuccessAt, timeZone)}.
        </p>
      )}
      {update !== null && update.lastError !== null && (
        <p
          role={failed ? "alert" : undefined}
          className={
            failed
              ? "text-sm [overflow-wrap:anywhere] text-destructive"
              : "text-sm [overflow-wrap:anywhere] text-warning"
          }
        >
          {failed
            ? `The last update failed on ${formatMoment(update.lastAttemptAt, timeZone)}, and the file was kept as it was: ${sentence(update.lastError)}${automatic ? " The worker tries again later on its own." : ""}`
            : sentence(update.lastError)}
        </p>
      )}
    </section>
  );
}

function LocationsStatus({
  status,
  automatic,
  timeZone,
  now,
}: {
  status: LocationDataStatus;
  automatic: boolean;
  timeZone: string;
  now: number;
}) {
  const { loaded, loadError, lastUpdate } = status.locations;
  if (status.geoSource !== "database") {
    return (
      <section className="flex flex-col gap-2 border-t pt-4" aria-label="Location database">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-ink">Location database</h3>
          <StatusBadge tone="neutral">Not needed</StatusBadge>
        </div>
        <p className="text-sm text-muted-foreground">
          {status.geoSource === "cloudflare"
            ? "Locations come from Cloudflare's headers (GEO_SOURCE=cloudflare). No database is downloaded."
            : "Location lookup is off (GEO_SOURCE=none). No database is downloaded."}
        </p>
      </section>
    );
  }
  return (
    <FileStatus
      title="Location database"
      file={{
        loaded:
          loaded === null
            ? null
            : `DB-IP City Lite, built ${formatDay(loaded.builtAt, timeZone)}. `,
        loadedModifiedAt: loaded?.fileModifiedAt ?? null,
        loadError,
        update: lastUpdate,
      }}
      consequence="No location database is loaded, so events are stored without a location."
      automatic={automatic}
      timeZone={timeZone}
      now={now}
      credit={
        <a
          href="https://db-ip.com"
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-4"
        >
          IP geolocation by DB-IP
        </a>
      }
    />
  );
}

function DataCentersStatus({
  status,
  automatic,
  timeZone,
  now,
}: {
  status: LocationDataStatus;
  automatic: boolean;
  timeZone: string;
  now: number;
}) {
  const { loaded, loadError, lastUpdate } = status.dataCenters;
  return (
    <FileStatus
      title="Data-center ranges"
      file={{
        loaded:
          loaded === null
            ? null
            : `${loaded.providers} cloud and hosting providers, downloaded ${formatDay(loaded.updatedAt, timeZone)}.`,
        loadedModifiedAt: loaded?.fileModifiedAt ?? null,
        loadError,
        update: lastUpdate,
      }}
      consequence="No data-center ranges are loaded, so visits from cloud servers are not recognized as bots."
      automatic={automatic}
      timeZone={timeZone}
      now={now}
    />
  );
}

/**
 * The Location data tab of the instance's Settings, for the owner: whether
 * the worker keeps the files current, and each file's state. The switch
 * saves with the section's Save (docs/design-system.md, "The save rule").
 */
function LocationDataForm({
  settings,
  timeZone,
  onDirty,
}: {
  settings: Settings;
  timeZone: string;
  onDirty: (dirty: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const form = useDirtyForm({ updateLocationData: settings.updateLocationData });
  React.useEffect(() => onDirty(form.dirty), [onDirty, form.dirty]);
  const status = useQuery(locationDataQuery());
  const save = useMutation({
    mutationFn: (values: { updateLocationData: boolean }) => updateSettings(values),
    onSuccess: (updated, values) => {
      form.saved(values);
      queryClient.setQueryData(settingsQuery().queryKey, updated);
    },
  });
  const switchId = React.useId();
  const descriptionId = React.useId();
  const automatic = settings.updateLocationData;

  return (
    <SettingsSection
      title="Location data"
      form={form}
      onSave={(values) => save.mutate(values)}
      saving={save.isPending}
      error={save.error?.message}
      saveLabel="Save location data settings"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor={switchId}>Update location data automatically</Label>
          <p id={descriptionId} className="text-sm text-muted-foreground">
            Downloads DB-IP locations monthly and cloud address ranges weekly, with no restart. Turn
            off without internet access. You can also run update-geo.mjs manually.
          </p>
        </div>
        <Switch
          id={switchId}
          name="updateLocationData"
          aria-describedby={descriptionId}
          checked={form.values.updateLocationData}
          disabled={save.isPending}
          onCheckedChange={(checked) => form.set("updateLocationData", checked)}
        />
      </div>
      {!automatic && (
        <p className="text-sm text-muted-foreground">
          Automatic updates are off. The files stay as they are until someone runs update-geo.mjs.
        </p>
      )}
      {status.isPending && (
        <div className="flex flex-col gap-3 border-t pt-4" aria-busy="true">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-full" />
        </div>
      )}
      {status.isError && (
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertTitle>The location data's status could not load</AlertTitle>
          <AlertDescription>{status.error.message}</AlertDescription>
          <AlertAction>
            <Button type="button" variant="outline" size="sm" onClick={() => void status.refetch()}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      )}
      {status.isSuccess && (
        <>
          <LocationsStatus
            status={status.data}
            automatic={automatic}
            timeZone={timeZone}
            now={Date.parse(status.data.now)}
          />
          <DataCentersStatus
            status={status.data}
            automatic={automatic}
            timeZone={timeZone}
            now={Date.parse(status.data.now)}
          />
        </>
      )}
    </SettingsSection>
  );
}

/** The tab, once the settings have loaded (the General tab loads the same query). */
export function LocationDataTab({ timeZone, onDirty }: InstanceTabProps) {
  const settings = useQuery(settingsQuery());
  if (settings.isPending) return <SectionSkeleton />;
  if (settings.isError) {
    return (
      <SectionFailed
        title="The settings could not load"
        message={settings.error.message}
        retry={() => void settings.refetch()}
      />
    );
  }
  return <LocationDataForm settings={settings.data} timeZone={timeZone} onDirty={onDirty} />;
}
