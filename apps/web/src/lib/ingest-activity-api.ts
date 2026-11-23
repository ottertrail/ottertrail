import { queryOptions } from "@tanstack/react-query";

import { apiRequest, expectShape } from "./api";

/**
 * Ingestion counts update every 15 seconds and are kept 7 days, for the owner and admins
 * (docs/dashboard.md, "Activity").
 */

export const INGEST_SOURCES = [
  "browser_events",
  "server_events",
  "errors",
  "web_vitals",
  "replays",
  "heatmaps",
  "traces",
  "logs",
  "metrics",
  "ai_calls",
  "source_maps",
] as const;
export type IngestSource = (typeof INGEST_SOURCES)[number];

export const INGEST_OUTCOMES = [
  "accepted",
  "filtered_bot",
  "filtered_spam",
  "filtered_too_old",
  "refused_origin",
  "refused_disabled",
  "refused_invalid",
  "refused_rate_limited",
  "refused_volume",
  "refused_unavailable",
] as const;
export type IngestOutcome = (typeof INGEST_OUTCOMES)[number];

/** Requests, and the items they stood for when the route knew how many. */
export interface ActivityCount {
  count: number;
  items: number;
}

/** One outcome's counts: `hour` is this hour, `day` and `week` the 24 hours and 7 days ending with it. */
export interface OutcomeCounts {
  hour: ActivityCount;
  day: ActivityCount;
  week: ActivityCount;
  /** When the latest of them arrived. */
  lastAt: string;
}

export interface SourceActivity {
  source: IngestSource;
  /** When the latest accepted request arrived in the 7 days; null when none did. */
  lastAcceptedAt: string | null;
  /** The outcomes with any count in the 7 days. */
  outcomes: Partial<Record<IngestOutcome, OutcomeCounts>>;
}

/** Where each window starts, in whole hours: this hour, and the 24 hours and 7 days that end with it. */
export interface ActivityWindows {
  hour: string;
  day: string;
  week: string;
}

/** GET /api/projects/:id/ingest-activity */
export interface IngestActivity {
  now: string;
  since: ActivityWindows;
  /** Every source, in INGEST_SOURCES' order. */
  sources: SourceActivity[];
}

const SOURCE_NAMES: ReadonlySet<string> = new Set(INGEST_SOURCES);
const OUTCOME_NAMES: ReadonlySet<string> = new Set(INGEST_OUTCOMES);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is ActivityCount =>
  isRecord(value) && typeof value.count === "number" && typeof value.items === "number";

const isOutcomeCounts = (value: unknown): value is OutcomeCounts =>
  isRecord(value) &&
  isCount(value.hour) &&
  isCount(value.day) &&
  isCount(value.week) &&
  typeof value.lastAt === "string";

const isSource = (value: unknown): value is SourceActivity =>
  isRecord(value) &&
  typeof value.source === "string" &&
  SOURCE_NAMES.has(value.source) &&
  (value.lastAcceptedAt === null || typeof value.lastAcceptedAt === "string") &&
  isRecord(value.outcomes) &&
  Object.entries(value.outcomes).every(
    ([outcome, counts]) => OUTCOME_NAMES.has(outcome) && isOutcomeCounts(counts),
  );

const isActivity = (value: unknown): value is IngestActivity =>
  isRecord(value) &&
  typeof value.now === "string" &&
  isRecord(value.since) &&
  typeof value.since.hour === "string" &&
  typeof value.since.day === "string" &&
  typeof value.since.week === "string" &&
  Array.isArray(value.sources) &&
  value.sources.every(isSource);

export const ingestActivityQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["ingest-activity", projectId],
    queryFn: async ({ signal }) =>
      expectShape(
        await apiRequest(`/api/projects/${encodeURIComponent(projectId)}/ingest-activity`, {
          signal,
        }),
        isActivity,
      ),
  });
