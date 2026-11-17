import { DEFAULT_ENVIRONMENT, DEFAULT_PERIOD, type PageRange } from "@/lib/analytics-api";
import { DEFAULT_STATUS_FILTER, type StatusFilter } from "@/lib/errors-api";

/** What the errors pages' addresses hold. */
export interface ErrorsSearch {
  range: PageRange;
  environment: string;
  /** The list only. */
  status?: StatusFilter;
}

/** The address query: the default period, environment, and status are left out. */
export const errorsSearchOf = ({ range, environment, status }: ErrorsSearch) => ({
  ...("period" in range
    ? range.period === DEFAULT_PERIOD
      ? {}
      : { period: range.period }
    : { from: range.from, to: range.to }),
  ...(environment === DEFAULT_ENVIRONMENT ? {} : { env: environment }),
  ...(status === undefined || status === DEFAULT_STATUS_FILTER ? {} : { status }),
});
