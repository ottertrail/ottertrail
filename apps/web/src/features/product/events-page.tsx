import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, MousePointerClickIcon } from "lucide-react";
import * as React from "react";

import { BreakdownTable } from "@/components/breakdown-table";
import { ButtonAnchor } from "@/components/button-anchor";
import { CopyableCode } from "@/components/copyable-code";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { useSettled } from "@/hooks/use-settled";
import { DEFAULT_ENVIRONMENT, type PageRange } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import { DOCS_URL } from "@/lib/docs";
import { type ProductEvents, productEventsQuery } from "@/lib/product-api";

import { ReportFilterBar } from "../errors/range-controls";
import { NoSuchProject } from "../projects/no-such-project";
import { CountChange, EventNotes } from "./event-notes";
import { comparedWith } from "./format";
import { LoadFailed, LoadingRows, Refreshing } from "./report-state";
import { type ProductSearch, productSearchOf } from "./search";

const TRACK_EXAMPLE = `window.ottertrail?.track("signup", { plan: "team" });`;

function DocsButton({ path, children }: { path: string; children: React.ReactNode }) {
  return (
    <ButtonAnchor
      variant="outline"
      href={`${DOCS_URL}${path}`}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
      <ArrowUpRightIcon aria-hidden="true" />
      <span className="sr-only">(opens in a new tab)</span>
    </ButtonAnchor>
  );
}

function NoEvents({ environment }: { environment: string }) {
  const where = environment === DEFAULT_ENVIRONMENT ? "" : ` in ${environment}`;
  return (
    <Empty className="border border-dashed p-10">
      <EmptyHeader className="max-w-xl">
        <EmptyMedia variant="icon">
          <MousePointerClickIcon />
        </EmptyMedia>
        <EmptyTitle>No product events{where} in this period</EmptyTitle>
        <EmptyDescription>
          Send events such as signups or purchases from your site with{" "}
          <code className="font-mono">track()</code>, or from your server.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="max-w-xl text-left">
        <CopyableCode text={TRACK_EXAMPLE} copyLabel="Copy the example" />
        <div className="flex flex-wrap justify-center gap-2">
          <DocsButton path="/product-analytics/custom-events/">How to send events</DocsButton>
          <DocsButton path="/product-analytics/server-side-events/">
            Send from your server
          </DocsButton>
        </div>
      </EmptyContent>
    </Empty>
  );
}

function EventTable({
  data,
  projectId,
  search,
  searched,
}: {
  data: ProductEvents;
  projectId: string;
  search: ProductSearch;
  /** The text the names were searched for; empty for none. */
  searched: string;
}) {
  return (
    <BreakdownTable
      title="Events"
      headingLevel={2}
      caption="Product events, most frequent first"
      nameHeading="Event"
      figureHeadings={["Events", "Visitors", "Users"]}
      layout="stack"
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
        figures: [
          <CountChange key="events" now={event.events} before={event.previous.events} />,
          <CountChange key="visitors" now={event.visitors} before={event.previous.visitors} />,
          <CountChange key="users" now={event.users} before={event.previous.users} />,
        ],
      }))}
      empty={
        searched === ""
          ? "No product events in this period."
          : `No event name contains "${searched}" in this period.`
      }
      className="max-w-5xl"
    />
  );
}

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
  const [text, setText] = React.useState("");
  const searched = useSettled(text.trim(), 250);
  const query = useQuery(productEventsQuery(projectId, range, environment, searched));
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
  // Nothing sent at all in the period: how to send events, without a search box. Another
  // search's answer, shown while this one loads, says nothing about that.
  const noneYet =
    data !== undefined && !query.isPlaceholderData && data.events.length === 0 && searched === "";

  return (
    <div className="flex flex-col">
      <ReportFilterBar
        label="Period, environment, and search"
        range={range}
        environment={environment}
        answered={data}
        onRange={(next) => show({ range: next })}
        onEnvironment={(next) => show({ environment: next })}
        filters={
          data !== undefined &&
          !noneYet && (
            <Input
              type="search"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Search events"
              aria-label="Search events by name"
              autoComplete="off"
              maxLength={200}
              className="w-64 max-w-full"
            />
          )
        }
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
        ) : noneYet ? (
          <NoEvents environment={environment} />
        ) : (
          <>
            <Refreshing stale={query.isPlaceholderData}>
              <div className="flex flex-col gap-3">
                <EventTable data={data} projectId={projectId} search={search} searched={searched} />
                {data.events.length > 0 && (
                  <p className="text-xs text-ink-subtle">
                    {comparedWith(data.previous, data.timeZone)}
                  </p>
                )}
              </div>
            </Refreshing>
            <EventNotes list />
          </>
        )}
      </div>
    </div>
  );
}
