import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { MousePointerClickIcon } from "lucide-react";

import { CopyableCode } from "@/components/copyable-code";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DEFAULT_ENVIRONMENT, type PageRange } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import { type ProductEvents, productEventsQuery } from "@/lib/product-api";

import { formatWhole } from "../analytics/format";
import { RangeControls } from "../errors/range-controls";
import { NoSuchProject } from "../projects/no-such-project";
import { LoadFailed, LoadingRows, Refreshing } from "./report-state";
import { type ProductSearch, productSearchOf } from "./search";

/** How a page sends a product event. */
const TRACK_EXAMPLE = `window.ottertrail?.track("signup", { plan: "team" });`;

/** What the Visitors and Users columns count, for the notes under a report. */
export function WhoNote() {
  return (
    <>
      <strong className="font-medium text-ink-muted">Visitors</strong> are daily visitor IDs: one
      browser on one day, counted again the next day; server-side events have none.{" "}
      <strong className="font-medium text-ink-muted">Users</strong> are your site&apos;s IDs for
      signed-in users, and only count events sent while someone was signed in.
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
          Product events are the ones your site sends itself, such as a signup or a purchase, each
          with up to 30 properties. In the browser, call{" "}
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
    <Table>
      <caption className="sr-only">Product events, most frequent first</caption>
      <TableHeader>
        <TableRow>
          <TableHead>Event</TableHead>
          <TableHead className="text-right">Events</TableHead>
          <TableHead className="text-right">Visitors</TableHead>
          <TableHead className="text-right">Users</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.events.map((event) => (
          <TableRow key={event.name}>
            <TableCell className="max-w-md">
              <Link
                to="/projects/$projectId/product/events/$name"
                params={{ projectId, name: event.name }}
                search={productSearchOf(search)}
                className="block truncate font-mono text-link hover:underline"
                title={event.name}
              >
                {event.name}
              </Link>
            </TableCell>
            <TableCell className="text-right tabular-nums">{formatWhole(event.events)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatWhole(event.visitors)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatWhole(event.users)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
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
              <p className="text-xs text-ink-subtle">
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
  );
}
