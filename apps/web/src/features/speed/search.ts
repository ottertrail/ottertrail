import type { PageRange } from "@/lib/analytics-api";
import type { Device } from "@/lib/speed-api";

import { errorsSearchOf } from "../errors/search";

/** What the Speed page's address holds. */
export interface SpeedSearch {
  range: PageRange;
  environment: string;
  /** Left out for all devices. */
  device: Device | undefined;
}

/** The address query: the default period and environment, and all devices, are left out. */
export const speedSearchOf = ({ range, environment, device }: SpeedSearch) => ({
  ...errorsSearchOf({ range, environment }),
  ...(device === undefined ? {} : { device }),
});
