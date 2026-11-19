import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { MousePointerClickIcon } from "lucide-react";

import { BreakdownTable } from "@/components/breakdown-table";
import { CopyableCode } from "@/components/copyable-code";
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
import { type ProductEvents, productEventsQuery } from "@/lib/product-api";

import { formatWhole } from "../analytics/format";
import { ReportFilterBar } from "../errors/range-controls";
import { NoSuchProject } from "../projects/no-such-project";
import { LoadFailed, LoadingRows, Refreshing } from "./report-state";
import { type ProductSearch, productSearchOf } from "./search";

/** How a page sends a product event. */
const TRACK_EXAMPLE = `window.ottertrail?.track("signup", { plan: "team" });`;

/** What the Visitors and Users columns count, for the notes under a report. */
export function WhoNote() {
  return (
    <>
      <strong className="font-medium text-ink-muted">Visitors</strong> are daily visitor IDs. One
      browser counts once per day and again the next day. Server-side events have no visitor ID.{" "}
      <strong className="font-medium text-ink-muted">Users</strong> are your site's IDs for
      signed-in users. Only events sent while someone was signed in count.
    </>
  );
}

function NoEvents({ environment }: { environment: string }) {
  const where = environment === DEFAULT_ENVIRONMENT ? "" : ` in ${environment}`;
  return (
    <Empty className="border border-dashed p-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MousePointerClickIcon />
        </EmptyMedia>
        <EmptyTitle>No product events{where} in this period</EmptyTitle>
        <EmptyDescription>
          Product events are events your site sends, such as signups or purchases. Each has up to 30
          properties. In the browser, call{" "}
          <code className="font-mono">window.ottertrail.track(name, properties)</code> once the
          tracking snippet is on the page. From your server, send them to{" "}
          <code className="font-mono">POST /api/server-events</code> with the project&apos;s secret
          key, from its settings. Pageviews, time on page, errors, and Web Vitals are the
          tracker&apos;s own events and are not listed here.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="max-w-2xl text-left">
        <CopyableCode text={TRACK_EXAMPLE} copyLabel="Copy the example" />
      </EmptyContent>
    </Empty>
  );
}

function EventTable({
  data,
  projectId,
  search,
}: {
  data: ProductEvents;
  projectId: string;
  search: ProductSearch;
}) {
  return (
    <BreakdownTable
      title="Events"
      headingLevel={2}
      caption="Product events, most frequent first"
      nameHeading="Event"
      figureHeadings={["Events", "Visitors", "Users"]}
      rows={data.events.map((event) => ({
        key: event.name,
        title: event.name,
        bar: event.events,
        label: (
          <Link
            to="/projects/$projectId/product/events/$name"
            params={{ projectId, name: event.name }}
            search={productSearchOf(search)}
            className="font-mono text-link hover:underline"
          >
            {event.name}
          </Link>
        ),
        figures: [formatWhole(event.events), formatWhole(event.visitors), formatWhole(event.users)],
      }))}
      empty="No product events in this period."
      className="max-w-5xl"
    />
  );
}

/** The project's product events in a period: how often each happened, and by how many. */
export function EventsPage({
  projectId,
  range,
  environment = DEFAULT_ENVIRONMENT,
}: {
  projectId: string;
  range: PageRange;
  environment?: string;
}) {
  const navigate = useNavigate();
  const query = useQuery(productEventsQuery(projectId, range, environment));
  const search: ProductSearch = { range, environment };
  const show = (next: Partial<ProductSearch>) =>
    void navigate({
      to: "/projects/$projectId/product/events",
      params: { projectId },
      search: productSearchOf({ ...search, ...next }),
    });

  if (query.error instanceof ApiError && query.error.status === 404) {
    return <NoSuchProject />;
  }
  const data = query.data;

  return (
    <div className="flex flex-col">
      <ReportFilterBar
        range={range}
        environment={environment}
        answered={data}
        onRange={(next) => show({ range: next })}
        onEnvironment={(next) => show({ environment: next })}
      />
      <div className="flex flex-col gap-6 px-gutter py-5">
        {query.isError && (
          <LoadFailed
            what="The events"
            message={query.error.message}
            hasData={data !== undefined}
            onRetry={() => void query.refetch()}
          />
        )}
        {data === undefined ? (
          !query.isError && <LoadingRows rows={4} />
        ) : (
          <Refreshing stale={query.isPlaceholderData}>
            {data.events.length === 0 ? (
              <NoEvents environment={environment} />
            ) : (
              <>
                <EventTable data={data} projectId={projectId} search={search} />
                <p className="max-w-4xl text-xs text-pretty text-ink-subtle">
                  The events your site sends with <code className="font-mono">track()</code> or from
                  its server, most frequent first
                  {data.events.length === 100 ? " (the top 100)" : ""}. <WhoNote /> Open an event to
                  see its properties.
                </p>
              </>
            )}
          </Refreshing>
        )}
      </div>
    </div>
  );
}
