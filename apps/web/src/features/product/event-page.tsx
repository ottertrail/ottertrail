import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { FilterIcon, SearchXIcon, XIcon } from "lucide-react";

import { BreakdownTable } from "@/components/breakdown-table";
import { ButtonLink } from "@/components/button-link";
import { PageBack } from "@/components/page-back";
import { PageActions, PageTitle } from "@/components/page-header";
import { ReportChart } from "@/components/report-chart";
import { type Stat, StatStrip } from "@/components/stat-strip";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { DEFAULT_ENVIRONMENT, type PageRange } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import {
  MAX_FILTERS,
  type ProductEventDetail,
  type PropertyBreakdown,
  type PropertyFilter,
  productEventQuery,
  productEventSourcesQuery,
  type VisitSourceValue,
} from "@/lib/product-api";

import { DayChart } from "../analytics/day-chart";
import { formatDay, formatWhole, relativeChange } from "../analytics/format";
import { valueText } from "../analytics/list-rows";
import { ReportFilterBar } from "../errors/range-controls";
import { MIN_LOADS_FOR_CHANGE } from "../overview/format";
import { NoSuchProject } from "../projects/no-such-project";
import { EventNotes } from "./event-notes";
import { comparedWith, filterText } from "./format";
import { LoadFailed, LoadingRows, Refreshing } from "./report-state";
import { filterSearchOf, type ProductSearch, productSearchOf } from "./search";

interface EventSearch extends ProductSearch {
  filters: PropertyFilter[];
}

const eventSearchOf = ({ filters, ...search }: EventSearch) => ({
  ...productSearchOf(search),
  ...filterSearchOf(filters),
});

function FilterChips({
  filters,
  onRemove,
}: {
  filters: PropertyFilter[];
  onRemove: (filter: PropertyFilter) => void;
}) {
  if (filters.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="text-sm text-ink-subtle">Only events where</span>
      <ul className="flex flex-wrap items-center gap-2" aria-label="Property filters">
        {filters.map((filter) => (
          <li
            key={filter.key}
            className="inline-flex h-7 items-center gap-1 rounded-4xl bg-muted pr-1 pl-3 text-sm text-ink"
          >
            <span className="font-mono">{filterText(filter)}</span>
            <button
              type="button"
              className="inline-flex size-5 items-center justify-center rounded-4xl text-ink-subtle hover:bg-accent hover:text-ink focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              aria-label={`Remove the filter ${filterText(filter)}`}
              onClick={() => onRemove(filter)}
            >
              <XIcon aria-hidden="true" className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Stats({ detail }: { detail: ProductEventDetail }) {
  const stat = (label: string, key: "events" | "visitors" | "users"): Stat => {
    const now = detail[key];
    const before = detail.previous[key];
    return {
      label,
      value: formatWhole(now),
      change: relativeChange(now, before),
      counts: { current: now, previous: before },
      before: formatWhole(before),
    };
  };
  return (
    <section aria-label="Summary" className="flex flex-col gap-3">
      <StatStrip
        label="Figures"
        stats={[stat("Events", "events"), stat("Visitors", "visitors"), stat("Users", "users")]}
        minCount={MIN_LOADS_FOR_CHANGE}
        className="sm:grid-cols-3 lg:max-w-2xl"
      />
      <p className="text-xs text-ink-subtle">{comparedWith(detail.previous, detail.timeZone)}</p>
    </section>
  );
}

function PropertyTable({
  property,
  projectId,
  name,
  search,
}: {
  property: PropertyBreakdown;
  projectId: string;
  name: string;
  search: EventSearch;
}) {
  const filtered = search.filters.some((filter) => filter.key === property.key);
  const full = search.filters.length >= MAX_FILTERS;
  return (
    <BreakdownTable
      title={property.key}
      headingLevel={4}
      description={`On ${formatWhole(property.events)} ${property.events === 1 ? "event" : "events"}`}
      caption={`${property.key}: its most frequent values`}
      nameHeading="Value"
      figureHeadings={["Events"]}
      rows={property.values.map((row) => {
        const filter = { key: property.key, value: row.value };
        const text = row.value === "" ? "(empty)" : row.value;
        return {
          key: row.value,
          title: text,
          bar: row.events,
          figures: [formatWhole(row.events)],
          label:
            filtered || full ? (
              <span className="font-mono">{text}</span>
            ) : (
              <Link
                to="/projects/$projectId/product/events/$name"
                params={{ projectId, name }}
                search={eventSearchOf({ ...search, filters: [...search.filters, filter] })}
                aria-label={`Filter by ${filterText(filter)}`}
                className="font-mono hover:text-link hover:underline"
              >
                {text}
              </Link>
            ),
        };
      })}
      empty="No values."
    />
  );
}

/** One visit dimension's values: null is an event without a visit. */
function VisitSourceTable({
  title,
  name,
  values,
}: {
  title: string;
  name: "source" | "utmCampaign";
  values: VisitSourceValue[];
}) {
  return (
    <BreakdownTable
      title={title}
      headingLevel={4}
      caption={`${title}: the most frequent values of the events' visits`}
      nameHeading={title}
      figureHeadings={["Events"]}
      rows={values.map((row) => {
        const text = row.value === null ? "Unknown" : valueText(name, row.value);
        return {
          key: row.value === null ? "unknown" : `value:${row.value}`,
          title: text,
          bar: row.events,
          figures: [formatWhole(row.events)],
          label: (
            <span className={row.value === null || row.value === "" ? "text-ink-subtle" : ""}>
              {text}
            </span>
          ),
        };
      })}
      empty="No values."
    />
  );
}

/**
 * The event by the source and campaign of the visit it happened in, as
 * the Analytics page counts them: its own request, so the rest of the
 * page does not wait for it.
 */
function VisitSources({
  projectId,
  name,
  search,
}: {
  projectId: string;
  name: string;
  search: EventSearch;
}) {
  const query = useQuery(
    productEventSourcesQuery(projectId, name, search.range, search.environment, search.filters),
  );
  const data = query.data;
  return (
    <section
      aria-labelledby="sources-heading"
      className="@container flex flex-col gap-4 border-t pt-5"
    >
      <div className="flex flex-col gap-1">
        <h3 id="sources-heading" className="text-sm font-medium text-ink">
          Sources
        </h3>
        <p className="max-w-4xl text-xs text-pretty text-ink-subtle">
          Where each event's visit came from. Events without a visit, such as a server's, are
          Unknown.
        </p>
      </div>
      {query.isError && (
        <LoadFailed
          what="The sources"
          message={query.error.message}
          hasData={data !== undefined}
          onRetry={() => void query.refetch()}
        />
      )}
      {data === undefined ? (
        !query.isError && <LoadingRows className="grid gap-8 @3xl:grid-cols-2" rows={2} />
      ) : (
        <Refreshing stale={query.isPlaceholderData}>
          <div className="grid gap-x-8 gap-y-8 @3xl:grid-cols-2 @6xl:grid-cols-3">
            <VisitSourceTable title="Source" name="source" values={data.source} />
            <VisitSourceTable title="Campaign" name="utmCampaign" values={data.utmCampaign} />
          </div>
        </Refreshing>
      )}
    </section>
  );
}

function NoMatch({ name, filtered }: { name: string; filtered: boolean }) {
  return (
    <Empty className="border border-dashed p-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchXIcon />
        </EmptyMedia>
        <EmptyTitle>
          {filtered
            ? `No ${name} event matches these filters in this period`
            : `No ${name} events in this period`}
        </EmptyTitle>
        <EmptyDescription>
          {filtered
            ? "Remove a filter, or choose a longer period."
            : "Choose a longer period, or check the event name. Names must match exactly."}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function EventsPerDay({ days }: { days: ProductEventDetail["days"] }) {
  return (
    <ReportChart
      title="Events per day"
      headingLevel={3}
      table={
        <table className="w-full max-w-md text-sm">
          <caption className="sr-only">Events per day</caption>
          <thead className="sticky top-0 bg-[var(--block-surface,var(--background))]">
            <tr className="text-xs text-ink-subtle">
              <th scope="col" className="pb-2 text-left font-normal">
                Day
              </th>
              <th scope="col" className="pb-2 text-right font-normal">
                Events
              </th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr key={day.day} className="border-t border-hairline">
                <th scope="row" className="py-1.5 text-left font-normal text-ink">
                  {formatDay(day.day, { weekday: true })}
                </th>
                <td className="py-1.5 text-right text-ink tabular-nums">
                  {formatWhole(day.events)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    >
      {days.length < 2 ? (
        <p className="py-8 text-center text-sm text-ink-subtle">
          A trend needs at least two days. Choose a longer period to see one.
        </p>
      ) : (
        <DayChart
          points={days.map((day) => ({ day: day.day, value: day.events }))}
          label="Events per day"
          tooltipRows={(index) => [
            { label: "Events", value: formatWhole(days[index]?.events ?? 0), plotted: true },
          ]}
          plotHeight={140}
        />
      )}
    </ReportChart>
  );
}

function Detail({
  detail,
  projectId,
  search,
}: {
  detail: ProductEventDetail;
  projectId: string;
  search: EventSearch;
}) {
  if (detail.events === 0) {
    return <NoMatch name={detail.name} filtered={search.filters.length > 0} />;
  }
  return (
    <>
      <Stats detail={detail} />
      <EventsPerDay days={detail.days} />
      <section
        aria-labelledby="properties-heading"
        className="@container flex flex-col gap-4 border-t pt-5"
      >
        <div className="flex flex-col gap-1">
          <h3 id="properties-heading" className="text-sm font-medium text-ink">
            Properties
          </h3>
          <p className="max-w-4xl text-xs text-pretty text-ink-subtle">
            {search.filters.length >= MAX_FILTERS
              ? `Each property's most frequent values. At most ${MAX_FILTERS} filters.`
              : "Each property's most frequent values. Select one to filter by it."}
          </p>
        </div>
        {detail.properties.length === 0 ? (
          <p className="border-t py-6 text-center text-sm text-ink-subtle">
            These events have no properties.
          </p>
        ) : (
          <div className="grid gap-x-8 gap-y-8 @3xl:grid-cols-2 @6xl:grid-cols-3">
            {detail.properties.map((property) => (
              <PropertyTable
                key={property.key}
                property={property}
                projectId={projectId}
                name={detail.name}
                search={search}
              />
            ))}
          </div>
        )}
      </section>
      <VisitSources projectId={projectId} name={detail.name} search={search} />
      <EventNotes />
    </>
  );
}

export function EventPage({
  projectId,
  name,
  range,
  environment = DEFAULT_ENVIRONMENT,
  filters,
}: {
  projectId: string;
  name: string;
  range: PageRange;
  environment?: string;
  filters: PropertyFilter[];
}) {
  const navigate = useNavigate();
  const query = useQuery(productEventQuery(projectId, name, range, environment, filters));
  const search: EventSearch = { range, environment, filters };
  const show = (next: Partial<EventSearch>) =>
    void navigate({
      to: "/projects/$projectId/product/events/$name",
      params: { projectId, name },
      search: eventSearchOf({ ...search, ...next }),
    });

  if (query.error instanceof ApiError && query.error.status === 404) {
    return <NoSuchProject />;
  }
  const data = query.data;

  return (
    <div className="flex flex-col">
      <ReportFilterBar
        label="Period, environment, and property filters"
        range={range}
        environment={environment}
        answered={data}
        onRange={(next) => show({ range: next })}
        onEnvironment={(next) => show({ environment: next })}
        filters={
          <FilterChips
            filters={filters}
            onRemove={(removed) =>
              show({ filters: filters.filter((filter) => filter.key !== removed.key) })
            }
          />
        }
      />
      <div className="flex flex-col gap-6 px-gutter py-5">
        <PageTitle title={name} />
        <PageBack
          label="All events"
          link={
            <Link
              to="/projects/$projectId/product/events"
              params={{ projectId }}
              search={productSearchOf(search)}
            />
          }
        />
        <PageActions>
          <ButtonLink
            variant="outline"
            to="/projects/$projectId/product/funnel"
            params={{ projectId }}
            search={{ ...productSearchOf(search), start: name }}
          >
            <FilterIcon data-icon="inline-start" />
            Start a funnel
          </ButtonLink>
        </PageActions>
        {query.isError && (
          <LoadFailed
            what="The event"
            message={query.error.message}
            hasData={data !== undefined}
            onRetry={() => void query.refetch()}
          />
        )}
        {data === undefined ? (
          !query.isError && (
            <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading">
              <div className="grid max-w-2xl grid-cols-3 gap-4">
                {["events", "visitors", "users"].map((item) => (
                  <div key={item} className="flex flex-col gap-2">
                    <Skeleton className="h-3 w-16" />
                    <Skeleton className="h-7 w-20" />
                  </div>
                ))}
              </div>
              <Skeleton className="h-44 w-full" />
              <div className="grid gap-8 lg:grid-cols-2">
                <Skeleton className="h-40 w-full" />
                <Skeleton className="h-40 w-full" />
              </div>
            </div>
          )
        ) : (
          <Refreshing stale={query.isPlaceholderData}>
            <Detail detail={data} projectId={projectId} search={search} />
          </Refreshing>
        )}
      </div>
    </div>
  );
}
