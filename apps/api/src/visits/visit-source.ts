import type { QueryParams } from "../clickhouse/query.ts";
import { VISIT_CONTEXT_MS, visitsSql } from "./visits.ts";

/**
 * Where a visit came from, and the visit an event belongs to, so an event
 * can be credited to its visit's source and campaign
 * (docs/product-analytics.md, "Source and campaign").
 */

/** A visit with no utm_source and no referrer from another site. */
export const DIRECT = "Direct / none";

/** Keep bracketed IPv6 hosts intact; otherwise stop at the port or path. */
const REFERRER_HOST_PATTERN = String.raw`^[a-zA-Z][a-zA-Z0-9+.-]*://(\[[^\]]*\]|[^/:]+)`;

/**
 * A visit's source, as the Analytics page's Sources list names it: its
 * utm_source, else its referrer's host without www., else DIRECT. A
 * referrer on one of the project's own hostnames is DIRECT. Reads a
 * visit's `referrer` and `utm_source` (visits.ts, FIRST_EVENT_COLUMNS).
 */
export function visitSourceSql(ownHostnames: readonly string[], params: QueryParams): string {
  const host = `nullIf(lower(replaceRegexpOne(extract(ifNull(referrer, ''), ${params.add(
    REFERRER_HOST_PATTERN,
    "String",
  )}), '^www\\\\.', '')), '')`;
  const own = params.add(
    ownHostnames.map((hostname) => hostname.toLowerCase().replace(/^www\./, "")),
    "Array(String)",
  );
  return `coalesce(utm_source, if(${host} IS NOT NULL AND NOT has(${own}, ${host}), ${host}, NULL), ${params.add(DIRECT, "String")})`;
}

/**
 * Dimensions over columns that visits (from their first event) and events
 * both have, named as the Analytics page's lists and filters. Fixed SQL,
 * never input. Region and city names repeat across countries
 * ("Springfield"), so the country is kept.
 */
export const COLUMN_DIMENSIONS = {
  country: "country",
  region: "if(region IS NULL, NULL, concat(region, ', ', ifNull(country, '?')))",
  city: "if(city IS NULL, NULL, concat(city, ', ', ifNull(country, '?')))",
  deviceType: "device_type",
  browser: "browser",
  os: "os",
  release: "release",
} as const;

export type ColumnDimension = keyof typeof COLUMN_DIMENSIONS;

/** The visit dimensions an event can be credited with, named as the Analytics page's filters. */
export const VISIT_SOURCE_NAMES = ["source", "utmCampaign"] as const;
export type VisitSourceName = (typeof VISIT_SOURCE_NAMES)[number];

export const isVisitSourceName = (name: string): name is VisitSourceName =>
  (VISIT_SOURCE_NAMES as readonly string[]).includes(name);

export interface AttributionRange {
  projectId: string;
  environment: string;
  /** The events to credit happened in [from, to). */
  from: Date;
  to: Date;
  /** The project's hostnames: a referrer on one is not a source. */
  ownHostnames: readonly string[];
}

/**
 * Each event of `events` with its visit's source and campaign as
 * `visit_source` and `visit_campaign`. `events` is SQL that selects at
 * least `visitor_id` and `occurred_at`; `visitors` is SQL that selects
 * the visitor IDs among them, so only their visits are worked out.
 *
 * An event belongs to the visit of the same visitor ID that started last
 * at or before it, when it happened before that visit ended. An event
 * with no visit (a server's event without a visitor ID, an error, or one
 * outside every visit) gets NULL for both. A visit without a campaign
 * gets "" for its campaign.
 *
 * Visitor IDs change daily, so a visit lasts at most 25 hours: the visits
 * read start that long before `from`.
 */
export function withVisitSourceSql(
  range: AttributionRange,
  events: string,
  visitors: string,
  params: QueryParams,
): string {
  const visits = visitsSql(
    {
      projectId: range.projectId,
      environment: range.environment,
      from: new Date(range.from.getTime() - VISIT_CONTEXT_MS),
      to: range.to,
    },
    params,
    { visitorsIn: visitors },
  );
  return `
    SELECT e.*,
           v.ended_at >= e.occurred_at AS in_visit,
           if(in_visit, v.source, NULL) AS visit_source,
           if(in_visit, ifNull(v.utm_campaign, ''), NULL) AS visit_campaign
    FROM (${events}) AS e
    ASOF LEFT JOIN (
      SELECT visitor_id, started_at, ended_at, utm_campaign,
             ${visitSourceSql(range.ownHostnames, params)} AS source
      FROM (${visits})
    ) AS v ON e.visitor_id = v.visitor_id AND e.occurred_at >= v.started_at`;
}

/** The column withVisitSourceSql gives for one dimension. */
export const VISIT_SOURCE_COLUMNS: Record<VisitSourceName, string> = {
  source: "visit_source",
  utmCampaign: "visit_campaign",
};
