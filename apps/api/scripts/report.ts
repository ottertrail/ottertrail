/**
 * Prints a project's reports for the last few days, counted in the
 * instance's TIMEZONE:
 *
 *   vp run report                    (the first project, last 7 days)
 *   vp run report -- Playground 30   (a project by name, last 30 days)
 *
 * The days are today and the days before it, so the last day is partial.
 */
import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/database.ts";
import {
  breakdown,
  customEvents,
  localDays,
  type ReportRange,
  summary,
  timeseries,
  topPages,
} from "../src/reports/reports.ts";
import { dayIn } from "../src/visitors/visitor-ids.ts";

// `vp run report -- …` passes the "--" separator through; skip it.
const [projectName, daysArgument = "7"] = process.argv.slice(2).filter((arg) => arg !== "--");
const dayCount = Number(daysArgument);
if (!Number.isInteger(dayCount) || dayCount < 1 || dayCount > 366) {
  console.error(
    `The number of days must be a whole number from 1 to 366, received "${daysArgument}".`,
  );
  process.exit(1);
}

const config = loadConfig();
const db = createDatabase({ connectionString: config.databaseUrl, maxConnections: 2 });

const percent = (value: number | null) => (value === null ? "-" : `${Math.round(value * 100)}%`);
const duration = (ms: number | null) => {
  if (ms === null) return "-";
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
};
const bar = (value: number, max: number) =>
  "█".repeat(max === 0 ? 0 : Math.round((value / max) * 30));

/** "YYYY-MM-DD" minus a number of calendar days. */
function daysBefore(day: string, count: number): string {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date - count)).toISOString().slice(0, 10);
}

try {
  const query = db.selectFrom("projects").select(["id", "name"]).orderBy("created_at").limit(1);
  const project = await (
    projectName === undefined ? query : query.where("name", "=", projectName)
  ).executeTakeFirst();
  if (project === undefined) {
    console.error(
      projectName === undefined
        ? "There are no projects."
        : `No project is named "${projectName}".`,
    );
    process.exitCode = 1;
  } else {
    const today = dayIn(config.timeZone)(new Date());
    const firstDay = daysBefore(today, dayCount - 1);
    const range: ReportRange = {
      projectId: project.id,
      timeZone: config.timeZone,
      ...(await localDays(db, firstDay, today, config.timeZone)),
    };

    console.log(
      `\n${project.name}: ${firstDay} to ${today} (${config.timeZone}; today is partial)\n`,
    );
    const total = await summary(db, range);
    console.table({
      Visitors: total.visitors,
      Pageviews: total.pageviews,
      Visits: total.visits,
      "Views per visit": total.viewsPerVisit === null ? "-" : total.viewsPerVisit.toFixed(1),
      "Bounce rate": percent(total.bounceRate),
      "Visit duration": duration(total.avgDurationMs),
      "Time engaged": duration(total.avgEngagedMs),
    });
    console.log("Visitors count each day separately: someone who came on 3 days counts 3 times.\n");

    const days = await timeseries(db, range);
    const busiest = Math.max(...days.map((d) => d.visitors));
    console.log("Visitors per day");
    for (const day of days)
      console.log(`${day.day}  ${String(day.visitors).padStart(5)}  ${bar(day.visitors, busiest)}`);

    console.log("\nTop pages");
    console.table(
      (await topPages(db, range)).map((p) => ({
        page: p.path,
        visitors: p.visitors,
        pageviews: p.pageviews,
        "time on page": duration(p.avgEngagedMs),
      })),
    );

    for (const [title, dimension] of [
      ["Sources", "source"],
      ["Campaigns", "utmCampaign"],
      ["Entry pages", "entryPage"],
      ["Exit pages", "exitPage"],
      ["Countries", "country"],
      ["Cities", "city"],
      ["Devices", "deviceType"],
      ["Browsers", "browser"],
      ["Operating systems", "os"],
    ] as const) {
      console.log(title);
      console.table(
        (await breakdown(db, range, dimension)).map((row) => ({
          [title.toLowerCase()]: row.value ?? "(unknown)",
          visitors: row.visitors,
          visits: row.visits,
          bounce: percent(row.bounceRate),
        })),
      );
    }

    console.log("Custom events");
    console.table(await customEvents(db, range));
    console.log("IP geolocation by DB-IP (https://db-ip.com)");
  }
} finally {
  await db.destroy();
}
