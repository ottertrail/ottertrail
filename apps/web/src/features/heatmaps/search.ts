import type { PageRange } from "@/lib/analytics-api";
import { type HeatmapDevice, isHeatmapDevice } from "@/lib/heatmaps-api";

import { errorsSearchOf } from "../errors/search";

/** What the Heatmaps page's address holds. */
export interface HeatmapsSearch {
  range: PageRange;
  environment: string;
  /** The page shown; left out for the page with the most pageviews. */
  path: string | undefined;
  /**
   * A device class, or "all" for every device. Left out, the page shows the
   * device with the most pageviews for the page and period, as layouts differ.
   */
  device: DeviceChoice | undefined;
}

/** What the device picker can hold: a device class, or all of them. */
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
