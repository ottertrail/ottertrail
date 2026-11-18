import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { UserRoundCheckIcon } from "lucide-react";

import { CopyableCode } from "@/components/copyable-code";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { DEFAULT_ENVIRONMENT, type PageRange } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import { type Cohort, type Retention, retentionQuery } from "@/lib/product-api";

import { formatDayRange, formatWhole } from "../analytics/format";
import { RangeControls } from "../errors/range-controls";
import { NoSuchProject } from "../projects/no-such-project";
import { formatShare } from "./format";
import { LoadFailed, LoadingRows, Refreshing } from "./report-state";
import { type ProductSearch, productSearchOf } from "./search";

/** How a site names its signed-in user. */
const IDENTIFY_EXAMPLE = `<script defer src="…/tracker.js" data-key="pk_…" data-user-id="42"></script>

// A single-page app, when someone signs in without a page load:
window.ottertrail?.identify("42");`;

/** The sequential scale's steps, lowest first: one per fifth of the cohort. */
const SHADES = ["bg-seq-1", "bg-seq-2", "bg-seq-3", "bg-seq-4", "bg-seq-5"] as const;
const LEGEND = ["1–20%", "21–40%", "41–60%", "61–80%", "81–100%"] as const;

/** The shade of a share from 0 to 1; none at 0. */
function shadeOf(share: number): string {
  if (!(share > 0)) return "";
  return SHADES[Math.min(SHADES.length, Math.ceil(share * SHADES.length)) - 1] ?? "";
}

const addWeeks = (monday: string, weeks: number) =>
  new Date(Date.parse(`${monday}T00:00:00Z`) + weeks * 7 * 86_400_000).toISOString().slice(0, 10);

/** Whether the cohort's last column is the current week, which is not over. */
const endsThisWeek = (cohort: Cohort, currentWeek: string) =>
  cohort.retained.length > 0 && addWeeks(cohort.week, cohort.retained.length - 1) === currentWeek;

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-subtle">
      <span>Share of the cohort:</span>
      <ul className="flex flex-wrap items-center gap-x-3 gap-y-1" aria-label="Shades">
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="size-3 rounded-sm ring-1 ring-hairline" />
          0%
        </li>
        {SHADES.map((shade, index) => (
          <li key={shade} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={`size-3 rounded-sm ${shade}`} />
            {LEGEND[index]}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CohortTable({ retention }: { retention: Retention }) {
  const weeks = Math.max(0, ...retention.cohorts.map((cohort) => cohort.retained.length));
  const notOver = retention.cohorts.some((cohort) => endsThisWeek(cohort, retention.currentWeek));
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>Weekly retention</h3>
        </CardTitle>
        <CardDescription>
          Each row is the signed-in users first seen in that week; each column, the share of them
          who came back that many weeks later.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-0.5 text-sm">
            <caption className="sr-only">
              Weekly retention of signed-in users, by the week of their first event
            </caption>
            <thead>
              <tr className="text-xs text-ink-subtle">
                <th scope="col" className="pr-3 pb-2 text-left font-normal whitespace-nowrap">
                  First week
                </th>
                <th scope="col" className="pr-3 pb-2 text-right font-normal">
                  Users
                </th>
                {Array.from({ length: weeks }, (_, week) => (
                  <th key={week} scope="col" className="min-w-14 pb-2 text-center font-normal">
                    Week {week}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {retention.cohorts.map((cohort) => {
                const current = endsThisWeek(cohort, retention.currentWeek);
                return (
                  <tr key={cohort.week}>
                    <th
                      scope="row"
                      className="py-1 pr-3 text-left font-normal whitespace-nowrap text-ink"
                    >
                      {formatDayRange(cohort.week, cohort.week)}
                    </th>
                    <td className="py-1 pr-3 text-right text-ink tabular-nums">
                      {formatWhole(cohort.users)}
                    </td>
                    {Array.from({ length: weeks }, (_, week) => {
                      const retained = cohort.retained[week];
                      if (retained === undefined) {
                        return (
                          <td key={week}>
                            <span className="sr-only">Not begun</span>
                          </td>
                        );
                      }
                      const last = current && week === cohort.retained.length - 1;
                      return (
                        <td
                          key={week}
                          title={`${formatWhole(retained)} of ${formatWhole(cohort.users)} users${last ? " so far: this week is not over" : ""}`}
                          className={`rounded-sm px-2 py-1 text-center text-ink tabular-nums ${shadeOf(cohort.users === 0 ? 0 : retained / cohort.users)} ${last ? "italic" : ""}`}
                          data-current={last ? "true" : undefined}
                        >
                          {formatShare(retained, cohort.users)}
                          {last && (
                            <>
                              <span aria-hidden="true">*</span>
                              <span className="sr-only"> (this week is not over)</span>
                            </>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Legend />
        {notOver && (
          <p className="text-xs text-ink-subtle">
            <span className="italic">*</span> This week is not over: its share can still grow.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** The definitions the report counts by (docs/product-analytics.md, "Retention"). */
function RetentionNotes({ timeZone }: { timeZone: string | undefined }) {
  return (
    <section aria-labelledby="retention-notes" className="flex flex-col gap-2">
      <h3 id="retention-notes" className="text-sm font-medium text-ink">
        How retention counts
      </h3>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-xs text-ink-subtle">
        <li>
          Signed-in users only, by your site&apos;s user ID. Visitors cannot be followed: their IDs
          change every day, so someone who comes back next week is a new visitor.
        </li>
        <li>
          A cohort is the users whose first event in this environment, over all the time the project
          keeps, was in that week. The period picks the cohorts: the latest 13 whose week overlaps
          it. Each cohort's weeks then run up to this week, whatever the period.
        </li>
        <li>
          A user came back in week <em>n</em> if they did anything themselves (any event but time on
          page and Web Vitals) in the <em>n</em>-th week after their first. Week 0 is everyone:
          100%.
        </li>
        <li>
          Weeks start on Monday in the timezone set in Settings
          {timeZone === undefined ? "" : ` (${timeZone})`}. Events can arrive up to a day late, so a
          week can still grow for a day after it ends.
        </li>
      </ul>
    </section>
  );
}

function NoCohorts({ environment }: { environment: string }) {
  const where = environment === DEFAULT_ENVIRONMENT ? "" : ` in ${environment}`;
  return (
    <Empty className="border border-dashed p-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <UserRoundCheckIcon />
        </EmptyMedia>
        <EmptyTitle>No signed-in users first seen{where} in this period</EmptyTitle>
        <EmptyDescription>
          Retention follows signed-in users from week to week, so it needs your site to name them.
          Add <code className="font-mono">data-user-id</code> with the signed-in user&apos;s ID to
          the tracking snippet on every page load. In a single-page app, also call{" "}
          <code className="font-mono">window.ottertrail.identify(id)</code> when someone signs in
          without a page load, and <code className="font-mono">reset()</code> when they sign out.
          Events sent from your server always carry a user ID.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="max-w-2xl text-left">
        <CopyableCode text={IDENTIFY_EXAMPLE} copyLabel="Copy the example" />
      </EmptyContent>
    </Empty>
  );
}

/**
 * Weekly retention of signed-in users: cohorts by the week of their first
 * event, and the share who did something in each week after.
 */
export function RetentionPage({
  projectId,
  range,
  environment = DEFAULT_ENVIRONMENT,
}: {
  projectId: string;
  range: PageRange;
  environment?: string;
}) {
  const navigate = useNavigate();
  const query = useQuery(retentionQuery(projectId, range, environment));
  const search: ProductSearch = { range, environment };
  const show = (next: Partial<ProductSearch>) =>
    void navigate({
      to: "/projects/$projectId/product/retention",
      params: { projectId },
      search: productSearchOf({ ...search, ...next }),
    });

  if (query.error instanceof ApiError && query.error.status === 404) {
    return <NoSuchProject />;
  }
  const data = query.data;

  return (
    <div className="flex flex-col gap-4">
      <RangeControls
        range={range}
        environment={environment}
        answered={data}
        onRange={(next) => show({ range: next })}
        onEnvironment={(next) => show({ environment: next })}
      />
      {query.isError && (
        <LoadFailed
          what="The retention report"
          message={query.error.message}
          hasData={data !== undefined}
          onRetry={() => void query.refetch()}
        />
      )}
      {data === undefined ? (
        !query.isError && <LoadingRows rows={6} />
      ) : (
        <Refreshing stale={query.isPlaceholderData}>
          {data.cohorts.length === 0 ? (
            <NoCohorts environment={environment} />
          ) : (
            <CohortTable retention={data} />
          )}
        </Refreshing>
      )}
      <RetentionNotes timeZone={data?.timeZone} />
    </div>
  );
}
