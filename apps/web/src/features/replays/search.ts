import type { PageRange } from "@/lib/analytics-api";
import { MIN_REPLAY_DURATIONS, type ReplayFilters } from "@/lib/replays-api";

import { environmentSearch, filterText, rangeSearch, searchValue } from "../telemetry/search";

/** An error group's fingerprint, as the API takes it. */
const FINGERPRINT = /^[0-9]{1,3}-[0-9a-f]{20}$/;

/** The Replays page's address. */
export interface ReplaysSearch {
  range: PageRange;
  environment: string;
  filters: ReplayFilters;
}

export const replaysSearchOf = ({ range, environment, filters }: ReplaysSearch) => ({
  ...rangeSearch(range),
  ...environmentSearch(environment),
  ...(filters.path === undefined ? {} : { path: filters.path }),
  ...(filters.userId === undefined ? {} : { user: filters.userId }),
  ...(filters.fingerprint === undefined ? {} : { error: filters.fingerprint }),
  ...(filters.minDuration === undefined ? {} : { min: filters.minDuration }),
});

/** The replay filters from an address; anything the page does not offer is dropped. */
export function replayFiltersFrom(search: {
  path?: unknown;
  user?: unknown;
  error?: unknown;
  min?: unknown;
}): ReplayFilters {
  const fingerprint = searchValue(search.error, 30);
  return {
    path: filterText(search.path),
    userId: filterText(search.user),
    fingerprint:
      fingerprint !== undefined && FINGERPRINT.test(fingerprint) ? fingerprint : undefined,
    minDuration: MIN_REPLAY_DURATIONS.find((value) => value === search.min),
  };
}
