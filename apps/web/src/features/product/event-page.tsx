import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, SearchXIcon, XIcon } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
} from "@/lib/product-api";

import { DayCountCard } from "../analytics/day-count-card";
import { formatWhole } from "../analytics/format";
import { RankedList } from "../analytics/ranked-list";
import { RangeControls } from "../errors/range-controls";
import { NoSuchProject } from "../projects/no-such-project";
import { WhoNote } from "./events-page";
import { filterText } from "./format";
import { LoadFailed, Refreshing } from "./report-state";
import { filterSearchOf, type ProductSearch, productSearchOf } from "./search";

interface EventSearch extends ProductSearch {
  filters: PropertyFilter[];
}

/** The detail's address: period, environment, and each filter as "p.<key>". */
const eventSearchOf = ({ filters, ...search }: EventSearch) => ({
  ...productSearchOf(search),
  ...filterSearchOf(filters),
});

/** The active filters, each removable. */
function FilterChips({
  filters,
  onRemove,
}: {
  filters: PropertyFilter[];
  onRemove: (filter: PropertyFilter) => void;
}) {
  if (filters.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
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
  const stats = [
    { label: "Events", value: detail.events },
    { label: "Visitors", value: detail.visitors },
    { label: "Users", value: detail.users },
  ];
  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid grid-cols-3 gap-x-6 gap-y-5">
          {stats.map((stat) => (
            <div key={stat.label} className="flex flex-col gap-1">
              <dt className="text-xs text-ink-subtle">{stat.label}</dt>
              <dd className="text-xl font-semibold tracking-tight text-ink tabular-nums">
                {formatWhole(stat.value)}
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-ink-subtle">
          <WhoNote />
        </p>
      </CardContent>
    </Card>
  );
}

/** One property's most frequent values; each adds itself as a filter. */
function PropertyCard({
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
    <Card>
      <CardHeader>
        <CardTitle>
          <h3 className="truncate font-mono" title={property.key}>
            {property.key}
          </h3>
        </CardTitle>
        <CardDescription>
          On {formatWhole(property.events)} {property.events === 1 ? "event" : "events"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <RankedList
          rows={property.values.map((row) => {
            const filter = { key: property.key, value: row.value };
            const text = row.value === "" ? "(empty)" : row.value;
            return {
              key: row.value,
              title: text,
              primary: row.events,
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
          caption={`${property.key}: its most frequent values`}
          nameHeading="Value"
          primaryHeading="Events"
          empty="No values."
        />
      </CardContent>
    </Card>
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
      <DayCountCard
        days={detail.days.map((day) => ({ day: day.day, count: day.events }))}
        noun="Events"
      />
      <section aria-labelledby="properties-heading" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h3 id="properties-heading" className="text-base font-medium text-ink">
            Properties
          </h3>
          <p className="text-xs text-ink-subtle">
            The 30 most common event properties, each with its 10 most frequent values. Values are
            compared as text. Numbers, true, false, and null use their JSON representations. Select
            a value to show only events with that value
            {search.filters.length >= MAX_FILTERS ? ` (at most ${MAX_FILTERS} filters)` : ""}.
          </p>
        </div>
        {detail.properties.length === 0 ? (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-ink-subtle">
            These events have no properties.
          </p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {detail.properties.map((property) => (
              <PropertyCard
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
    </>
  );
}

/**
 * One product event: its counts and trend in a period, and its properties
 * with their most frequent values, narrowed by property filters that live
 * in the address.
 */
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
    <div className="flex flex-col gap-4">
      <Link
        to="/projects/$projectId/product/events"
        params={{ projectId }}
        search={productSearchOf(search)}
        className="inline-flex items-center gap-1 self-start text-sm text-link hover:underline"
      >
        <ArrowLeftIcon aria-hidden="true" className="size-4" />
        All events
      </Link>
      <h2 className="truncate font-mono text-xl font-semibold text-ink" title={name}>
        {name}
      </h2>
      <RangeControls
        range={range}
        environment={environment}
        answered={data}
        onRange={(next) => show({ range: next })}
        onEnvironment={(next) => show({ environment: next })}
      />
      <FilterChips
        filters={filters}
        onRemove={(removed) =>
          show({ filters: filters.filter((filter) => filter.key !== removed.key) })
        }
      />
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
          <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading">
            <Skeleton className="h-28 w-full rounded-xl" />
            <Skeleton className="h-80 w-full rounded-xl" />
            <div className="grid gap-4 lg:grid-cols-2">
              <Skeleton className="h-56 w-full rounded-xl" />
              <Skeleton className="h-56 w-full rounded-xl" />
            </div>
          </div>
        )
      ) : (
        <Refreshing stale={query.isPlaceholderData}>
          <Detail detail={data} projectId={projectId} search={search} />
        </Refreshing>
      )}
    </div>
  );
}
