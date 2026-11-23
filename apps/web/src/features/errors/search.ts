import { DEFAULT_ENVIRONMENT, DEFAULT_PERIOD, type PageRange } from "@/lib/analytics-api";
import {
  type AssigneeFilter,
  DEFAULT_ASSIGNEE_FILTER,
  DEFAULT_STATUS_FILTER,
  type StatusFilter,
} from "@/lib/errors-api";

export interface ErrorsSearch {
  range: PageRange;
  environment: string;
  status?: StatusFilter;
  assignee?: AssigneeFilter;
}

/** Omit default period, environment, status, and assignee from the query. */
export const errorsSearchOf = ({ range, environment, status, assignee }: ErrorsSearch) => ({
  ...("period" in range
    ? range.period === DEFAULT_PERIOD
      ? {}
      : { period: range.period }
    : { from: range.from, to: range.to }),
  ...(environment === DEFAULT_ENVIRONMENT ? {} : { env: environment }),
  ...(status === undefined || status === DEFAULT_STATUS_FILTER ? {} : { status }),
  ...(assignee === undefined || assignee === DEFAULT_ASSIGNEE_FILTER ? {} : { assignee }),
});
