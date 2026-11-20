import { DEFAULT_ENVIRONMENT, DEFAULT_PERIOD, type PageRange } from "@/lib/analytics-api";
import {
  type AssigneeFilter,
  DEFAULT_ASSIGNEE_FILTER,
  DEFAULT_STATUS_FILTER,
  type StatusFilter,
} from "@/lib/errors-api";

/** What the errors pages' addresses hold. */
export interface ErrorsSearch {
  range: PageRange;
  environment: string;
  /** The list only. */
  status?: StatusFilter;
  /** The list only: whose groups. */
  assignee?: AssigneeFilter;
}

/** The address query: the default period, environment, status, and assignee are left out. */
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
