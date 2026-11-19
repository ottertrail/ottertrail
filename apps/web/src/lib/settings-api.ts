import { queryOptions } from "@tanstack/react-query";

import { apiRequest, expectShape } from "./api";

/** The instance's settings, as GET /api/settings returns them to the owner. */
export interface Settings {
  /** The instance's display name, shown at the top of the sidebar. */
  name: string;
  /** IANA timezone: reports count days in it. */
  timeZone: string;
  /** Whether the worker keeps the location database and data-center ranges current. */
  updateLocationData: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isSettings = (value: unknown): value is Settings =>
  isRecord(value) &&
  typeof value.name === "string" &&
  typeof value.timeZone === "string" &&
  typeof value.updateLocationData === "boolean";

const isSettingsBody = (value: unknown): value is { settings: Settings } =>
  isRecord(value) && isSettings(value.settings);

export const settingsQuery = () =>
  queryOptions({
    queryKey: ["settings"],
    queryFn: async ({ signal }) =>
      expectShape(await apiRequest("/api/settings", { signal }), isSettingsBody).settings,
  });

/** Changes the instance's name, timezone, or automatic location data updates; the owner only. */
export async function updateSettings(
  changes: Partial<Pick<Settings, "name" | "timeZone" | "updateLocationData">>,
) {
  const body = await apiRequest("/api/settings", { method: "PATCH", body: changes });
  return expectShape(body, isSettingsBody).settings;
}

/** A file's last update, as the worker or the manual command recorded it. */
export interface LocationDataUpdate {
  lastAttemptAt: string;
  /** Null when no attempt has worked yet. */
  lastSuccessAt: string | null;
  /** The location database's month, such as "2026-11". */
  version: string | null;
  /** When DB-IP built the location database, or when the ranges were downloaded. */
  builtAt: string | null;
  providers: number | null;
  /** The file as the update left it: compared with what the API loaded. */
  fileModifiedAt: string | null;
  /** Why the last attempt failed, or which sources failed; null after a clean one. */
  lastError: string | null;
}

/** GET /api/settings/location-data: what the API has loaded, and the last updates. */
export interface LocationDataStatus {
  /** The server's time when it answered: the page counts minutes from it, not the browser's clock. */
  now: string;
  geoSource: "database" | "cloudflare" | "none";
  locations: {
    loaded: { type: string; builtAt: string; fileModifiedAt: string | null } | null;
    /** Why the API could not use the last changed file; it kept the one before. */
    loadError: string | null;
    lastUpdate: LocationDataUpdate | null;
  };
  dataCenters: {
    loaded: { providers: number; updatedAt: string; fileModifiedAt: string | null } | null;
    loadError: string | null;
    lastUpdate: LocationDataUpdate | null;
  };
}

const isTextOrNull = (value: unknown) => value === null || typeof value === "string";

const isUpdate = (value: unknown): value is LocationDataUpdate | null =>
  value === null ||
  (isRecord(value) &&
    typeof value.lastAttemptAt === "string" &&
    isTextOrNull(value.lastSuccessAt) &&
    isTextOrNull(value.version) &&
    isTextOrNull(value.builtAt) &&
    (value.providers === null || typeof value.providers === "number") &&
    isTextOrNull(value.fileModifiedAt) &&
    isTextOrNull(value.lastError));

const isLocationDataStatus = (value: unknown): value is LocationDataStatus =>
  isRecord(value) &&
  typeof value.now === "string" &&
  (value.geoSource === "database" ||
    value.geoSource === "cloudflare" ||
    value.geoSource === "none") &&
  isRecord(value.locations) &&
  (value.locations.loaded === null ||
    (isRecord(value.locations.loaded) &&
      typeof value.locations.loaded.type === "string" &&
      typeof value.locations.loaded.builtAt === "string" &&
      isTextOrNull(value.locations.loaded.fileModifiedAt))) &&
  isTextOrNull(value.locations.loadError) &&
  isUpdate(value.locations.lastUpdate) &&
  isRecord(value.dataCenters) &&
  (value.dataCenters.loaded === null ||
    (isRecord(value.dataCenters.loaded) &&
      typeof value.dataCenters.loaded.providers === "number" &&
      typeof value.dataCenters.loaded.updatedAt === "string" &&
      isTextOrNull(value.dataCenters.loaded.fileModifiedAt))) &&
  isTextOrNull(value.dataCenters.loadError) &&
  isUpdate(value.dataCenters.lastUpdate);

export const locationDataQuery = () =>
  queryOptions({
    queryKey: ["settings", "location-data"],
    queryFn: async ({ signal }) =>
      expectShape(
        await apiRequest("/api/settings/location-data", { signal }),
        isLocationDataStatus,
      ),
  });
