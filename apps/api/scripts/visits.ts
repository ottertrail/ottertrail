/**
 * Prints a project's recent visits, worked out from its events, so you can
 * see the visit rules at work:
 *
 *   vp run visits                    (the first project, last 24 hours)
 *   vp run visits -- Playground 6    (a project by name, last 6 hours)
 *
 * Times are shown in the timezone of the project's organization.
 */
import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/database.ts";
import { findVisits } from "../src/visits/visits.ts";

// `vp run visits -- …` passes the "--" separator through; skip it.
const [projectName, hoursArgument = "24"] = process.argv.slice(2).filter((arg) => arg !== "--");
const hours = Number(hoursArgument);
if (!Number.isFinite(hours) || hours <= 0) {
  console.error(`The number of hours must be positive, received "${hoursArgument}".`);
  process.exit(1);
}

const config = loadConfig();
const db = createDatabase({ connectionString: config.databaseUrl, maxConnections: 1 });
const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

try {
  const query = db
    .selectFrom("projects")
    .innerJoin("organizations", "organizations.id", "projects.organization_id")
    .select(["projects.id", "projects.name", "organizations.time_zone"])
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
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone: project.time_zone,
      dateStyle: "short",
      timeStyle: "medium",
    });
    const to = new Date();
    const from = new Date(to.getTime() - hours * 60 * 60 * 1000);
    const visits = await findVisits(db, { projectId: project.id, from, to });
    console.log(
      `${project.name}: ${visits.length} visits started in the last ${hours} hours (${project.time_zone})`,
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
}
