import type { AiCallFilters } from "@/lib/ai-calls-api";
import { MAX_CONVERSATION_ID } from "@/lib/ai-calls-api";
import type { PageRange } from "@/lib/analytics-api";

import { aiFiltersFrom, environmentSearch, rangeSearch } from "../telemetry/search";

export type AiCallsView = "calls" | "conversations";

export interface AiCallsPlace {
  projectId: string;
  range: PageRange;
  environment: string;
  filters: AiCallFilters;
}

/** Keep conversation when switching views: it selects a conversation or filters its calls. */
export const aiCallsSearchOf = ({
  range,
  environment,
  filters,
  view = "calls",
}: {
  range: PageRange;
  environment: string;
  filters: AiCallFilters;
  view?: AiCallsView;
}) => ({
  ...rangeSearch(range),
  ...environmentSearch(environment),
  ...(view === "conversations" ? { view } : {}),
  ...(filters.service === undefined ? {} : { service: filters.service }),
  ...(filters.provider === undefined ? {} : { provider: filters.provider }),
  ...(filters.model === undefined ? {} : { model: filters.model }),
  ...(filters.feature === undefined ? {} : { feature: filters.feature }),
  ...(filters.user === undefined ? {} : { user: filters.user }),
  ...(filters.failed === true ? { status: "failed" as const } : {}),
  ...(filters.conversation === undefined ? {} : { conversation: filters.conversation }),
});

/** Text as the API takes it: 1 to `max` characters, no control characters; a number as text. */
function idText(value: unknown, max: number): string | undefined {
  const found = typeof value === "number" ? String(value) : value;
  if (typeof found !== "string" || found === "" || found.length > max) return undefined;
  // eslint-disable-next-line no-control-regex -- control characters are what it refuses
  return /[\u0000-\u001F\u007F-\u009F]/u.test(found) ? undefined : found;
}

export function aiCallFiltersFrom(search: {
  service?: unknown;
  provider?: unknown;
  model?: unknown;
  feature?: unknown;
  user?: unknown;
  conversation?: unknown;
  status?: unknown;
}): AiCallFilters {
  return {
    ...aiFiltersFrom(search),
    user: idText(search.user, 200),
    conversation: idText(search.conversation, MAX_CONVERSATION_ID),
    failed: search.status === "failed" ? true : undefined,
  };
}

export const aiCallsViewFrom = (value: unknown): AiCallsView =>
  value === "conversations" ? "conversations" : "calls";

/** A call's row ID, as the API takes it: a span's 48 hex digits, or a UUID. */
export const isCallId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^([0-9a-f]{48}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(value);
