import { identifier } from "../clickhouse/clickhouse.ts";
import { RELEASE_FIRST_SEEN } from "../clickhouse/migrations.ts";
import { fromClickHouseTime, QueryParams, queryRows, type Reader } from "../clickhouse/query.ts";

/** A release's first event in one environment. */
export interface ReleaseMark {
  release: string;
  firstSeen: Date;
  /** "YYYY-MM-DDTHH:mm" in the instance's timezone. */
  local: string;
}

/** The most release marks one answer holds: more would cover the chart. */
export const MAX_RELEASE_MARKS = 200;

function localMinute(timeZone: string): (moment: Date) => string {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return (moment) => {
    const parts = Object.fromEntries(
      format.formatToParts(moment).map((part) => [part.type, part.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  };
}

/**
 * The releases of one environment first seen from `from` up to `to`, in
 * time order, the earliest MAX_RELEASE_MARKS. A release first seen before
 * `from` has none. Reads release_first_seen (ClickHouse migration 0017),
 * one row per release of the environment, never the events.
 */
export async function releasesFirstSeen(
  reader: Reader,
  scope: { projectId: string; environment: string; timeZone: string },
  range: { from: Date; to: Date },
): Promise<ReleaseMark[]> {
  const params = new QueryParams();
  const project = params.add(scope.projectId, "UUID");
  const environment = params.add(scope.environment, "String");
  const from = params.time(range.from);
  const to = params.time(range.to);
  const rows = await queryRows<{ release: string; first: string }>(
    reader,
    `SELECT release, first FROM (
       SELECT release, minMerge(first_seen) AS first
       FROM ${identifier(RELEASE_FIRST_SEEN)}
       WHERE project_id = ${project} AND environment = ${environment}
       GROUP BY release
     )
     WHERE first >= ${from} AND first < ${to}
     ORDER BY first, release
     LIMIT ${MAX_RELEASE_MARKS}`,
    params,
  );
  const local = localMinute(scope.timeZone);
  return rows.map((row) => {
    const firstSeen = fromClickHouseTime(row.first);
    return { release: row.release, firstSeen, local: local(firstSeen) };
  });
}
