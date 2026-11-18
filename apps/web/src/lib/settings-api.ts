import { queryOptions } from "@tanstack/react-query";

import { apiRequest, expectShape } from "./api";

/** The instance's settings, as GET /api/settings returns them to the owner. */
export interface Settings {
  /** The instance's display name, shown at the top of the sidebar. */
  name: string;
  /** IANA timezone: reports count days in it. */
  timeZone: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isSettings = (value: unknown): value is Settings =>
  isRecord(value) && typeof value.name === "string" && typeof value.timeZone === "string";

const isSettingsBody = (value: unknown): value is { settings: Settings } =>
  isRecord(value) && isSettings(value.settings);

export const settingsQuery = () =>
  queryOptions({
    queryKey: ["settings"],
    queryFn: async ({ signal }) =>
      expectShape(await apiRequest("/api/settings", { signal }), isSettingsBody).settings,
  });

/** Changes the instance's name or timezone; the owner only. */
export async function updateSettings(changes: { name?: string; timeZone?: string }) {
  const body = await apiRequest("/api/settings", { method: "PATCH", body: changes });
  return expectShape(body, isSettingsBody).settings;
}
