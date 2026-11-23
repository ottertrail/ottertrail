import type { PageRange } from "@/lib/analytics-api";
import { type HeatmapDevice, isHeatmapDevice } from "@/lib/heatmaps-api";

import { errorsSearchOf } from "../errors/search";

export interface HeatmapsSearch {
  range: PageRange;
  environment: string;
  /** The page shown; left out for the page with the most pageviews. */
  path: string | undefined;
  /** Omit to derive the most-viewed device for this page and period; do not save the derived value. */
  device: DeviceChoice | undefined;
}

export type DeviceChoice = HeatmapDevice | "all";

export const isDeviceChoice = (value: unknown): value is DeviceChoice =>
  value === "all" || isHeatmapDevice(value);

/** The address query: the default period and environment, the top page, and the top device are left out. */
export const heatmapsSearchOf = ({ range, environment, path, device }: HeatmapsSearch) => ({
  ...errorsSearchOf({ range, environment }),
  ...(path === undefined ? {} : { path }),
  ...(device === undefined ? {} : { device }),
});

/** A page path the address may name: starts with "/", at most 2,048 characters. */
export function pathFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith("/") && value.length <= 2048
    ? value
    : undefined;
}
