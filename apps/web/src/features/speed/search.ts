import type { PageRange } from "@/lib/analytics-api";
import type { Device } from "@/lib/speed-api";

import { errorsSearchOf } from "../errors/search";

export interface SpeedSearch {
  range: PageRange;
  environment: string;
  device: Device | undefined;
}

export const speedSearchOf = ({ range, environment, device }: SpeedSearch) => ({
  ...errorsSearchOf({ range, environment }),
  ...(device === undefined ? {} : { device }),
});
