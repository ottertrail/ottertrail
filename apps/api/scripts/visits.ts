/**
 * Prints a project's recent visits, worked out from its events, so you can
 * see the visit rules at work:
 *
 *   vp run visits                            (the first project, last 24 hours)
 *   vp run visits -- Playground 6            (a project by name, last 6 hours)
 *   vp run visits -- Playground 6 staging    (another environment than production)
 *
 * Times are shown in the instance's timezone. Visits are
 * worked out from the events in ClickHouse.
 */
import { createClickHouse } from "../src/clickhouse/clickhouse.ts";
import type { Reader } from "../src/clickhouse/query.ts";
import { DEFAULT_ENVIRONMENT } from "../src/collection/environment.ts";
import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/database.ts";
import { readInstanceSettings } from "../src/settings/settings.ts";
import { findVisits } from "../src/visits/visits.ts";

// `vp run visits -- …` passes the "--" separator through; skip it.
const [projectName, hoursArgument = "24", environment = DEFAULT_ENVIRONMENT] = process.argv
  .slice(2)
  .filter((arg) => arg !== "--");
const hours = Number(hoursArgument);
if (!Number.isFinite(hours) || hours <= 0) {
  console.error(`The number of hours must be positive, received "${hoursArgument}".`);
  process.exit(1);
}

const config = loadConfig();
const db = createDatabase({ connectionString: config.databaseUrl, maxConnections: 1 });
const reader: Reader = { client: createClickHouse(config.clickhouse) };
const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

try {
  const query = db
    .selectFrom("projects")
    .select(["projects.id", "projects.name"])
    .orderBy("projects.created_at")
    .limit(1);
  const project = await (
    projectName === undefined ? query : query.where("projects.name", "=", projectName)
  ).executeTakeFirst();
  if (project === undefined) {
    console.error(
      projectName === undefined
        ? "There are no projects."
        : `No project is named "${projectName}".`,
    );
    process.exitCode = 1;
  } else {
    const { timeZone } = await readInstanceSettings(db);
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      dateStyle: "short",
      timeStyle: "medium",
    });
    const to = new Date();
    const from = new Date(to.getTime() - hours * 60 * 60 * 1000);
    const visits = await findVisits(reader, {
      projectId: project.id,
      environment: environment.toLowerCase(),
      from,
      to,
    });
    console.log(
      `${project.name}, ${environment.toLowerCase()}: ${visits.length} visits started in the last ${hours} hours (${timeZone})`,
    );
    console.table(
      visits.map((visit) => ({
        started: time.format(visit.startedAt),
        visitor: visit.visitorId,
        pages: visit.pageviews,
        "entry → exit": `${visit.entryPath ?? "-"} → ${visit.exitPath ?? "-"}`,
        duration: seconds(visit.durationMs),
        engaged: seconds(visit.engagedMs),
        bounce: visit.bounce,
        from: visit.utmSource ?? (visit.referrer ? new URL(visit.referrer).host : "direct"),
        browser: visit.browser ?? "-",
        where: [visit.city, visit.country].filter(Boolean).join(", ") || "-",
      })),
    );
    console.log("IP geolocation by DB-IP (https://db-ip.com)");
  }
} finally {
  await db.destroy();
  await reader.client.close();
}
