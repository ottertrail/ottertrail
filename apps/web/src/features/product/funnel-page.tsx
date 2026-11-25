import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, ChevronRightIcon, FilterIcon, PencilIcon, PlusIcon } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { WhenAllowed } from "@/components/when-allowed";
import { WorkbenchKeyHints } from "@/components/workbench";
import { useAccess } from "@/lib/access";
import { DEFAULT_ENVIRONMENT, type PageRange } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import { savedFunnelsQuery } from "@/lib/funnels-api";
import { goalsQuery } from "@/lib/goals-api";
import {
  DEFAULT_FUNNEL_COUNT,
  DEFAULT_FUNNEL_WINDOW,
  type FunnelBreakdownBy,
  type FunnelCount,
  type FunnelStep,
  type FunnelWindow,
  funnelQuery,
  funnelTimesQuery,
  MIN_STEPS,
  productEventsQuery,
  savedFunnelResultsQuery,
} from "@/lib/product-api";

import { ReportFilterBar } from "../errors/range-controls";
import { NoSuchProject } from "../projects/no-such-project";
import { countLine, stepsLine, windowLabel } from "./format";
import { FunnelBreakdownSection } from "./funnel-breakdown";
import { FunnelEditorDialog } from "./funnel-editor-dialog";
import { FunnelPeopleDialog, type PeopleList } from "./funnel-people-dialog";
import { FunnelResults } from "./funnel-results";
import { stepText } from "./funnel-steps";
import { FunnelTrendSection } from "./funnel-trend";
import { LoadFailed, Refreshing } from "./report-state";
import { SaveFunnelActions } from "./save-funnel-actions";
import { SAVED_FUNNEL_KEYS } from "./saved-funnels";
import { SavedFunnelsCard } from "./saved-funnels-card";
import {
  breakdownFor,
  type FunnelSearch,
  funnelSearchOf,
  isShownFunnel,
  productSearchOf,
} from "./search";

/** The definitions the funnel counts by (docs/product-analytics.md, "Funnel"). */
function FunnelNotes({ window }: { window: FunnelWindow }) {
  return (
    <details className="group border-t pt-5">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-ink [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          aria-hidden="true"
          className="size-4 text-ink-subtle transition-transform group-open:rotate-90 motion-reduce:transition-none"
        />
        How the funnel counts
      </summary>
      <ul className="mt-2 flex max-w-prose list-disc flex-col gap-1 pl-5 text-xs text-pretty text-ink-subtle">
        <li>
          Someone reaches a step after completing all previous steps in order. Other events between
          steps are allowed.
        </li>
        <li>
          Every step must happen within the conversion window ({windowLabel(window)}), counted from
          their step 1.
        </li>
        <li>
          Step 1 must occur in the selected period. Later steps may occur after the period ends,
          within the conversion window.
        </li>
        <li>
          Visitors can be followed for at most one day. Their IDs change daily, so a returning
          visitor counts as someone new tomorrow. Users are your site's IDs for signed-in users.
          They can be followed for up to 30 days. Only events sent while the user was signed in
          count.
        </li>
        <li>
          A page step matches pageviews with exactly that path. An event step's property filter
          compares values as text. Numbers, true, false, and null use their JSON representations.
        </li>
        <li>
          Conversion over time puts each person on the day of their first step 1 in the period, or
          its week when the period is longer than 60 days. A day when nobody did step 1 has no
          point.
        </li>
        <li>
          Time between steps is measured for the people who reached the later step, between the
          events the funnel counted. When someone repeats step 1, the latest time before they go on
          counts. A repeated later step keeps its first time.
        </li>
        <li>A breakdown counts each person under the value on their first step 1 in the period.</li>
        <li>Counted by users, each step lists who dropped off after it.</li>
      </ul>
    </details>
  );
}

/** The page when the project has no saved funnel yet. */
function NoFunnels({
  example,
  onNew,
  onExample,
}: {
  example: FunnelStep[];
  onNew: () => void;
  onExample: () => void;
}) {
  return (
    <Empty className="border border-dashed p-10">
      <EmptyHeader className="max-w-xl">
        <EmptyMedia variant="icon">
          <FilterIcon />
        </EmptyMedia>
        <EmptyTitle>No funnels yet</EmptyTitle>
        <EmptyDescription>
          A funnel counts how many people take steps in order, such as{" "}
          {example.map((step, index) => (
            <span key={index}>
              {index > 0 && " then "}
              {step.type === "page" ? "the page " : "the event "}
              <code className="font-mono">{stepText(step)}</code>
            </span>
          ))}
          , and where they stop.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row flex-wrap justify-center gap-2">
        <Button onClick={onNew}>
          <PlusIcon data-icon="inline-start" />
          New funnel
        </Button>
        <Button variant="outline" onClick={onExample}>
          Try this example
        </Button>
      </EmptyContent>
    </Empty>
  );
}

/**
 * The saved funnels, with New funnel; or one funnel, shown from the address (its steps, who it
 * counts, and its window), with Edit steps and Save. Building and editing happen in a dialog.
 */
export function FunnelPage({
  projectId,
  range,
  environment = DEFAULT_ENVIRONMENT,
  funnel,
  steps,
  count,
  window,
  by: asked,
}: {
  projectId: string;
  range: PageRange;
  environment?: string;
  funnel?: string | undefined;
  steps: FunnelStep[];
  count: FunnelCount;
  window: FunnelWindow;
  /** The breakdown under the result, from the address; not saved with a funnel. */
  by?: FunnelBreakdownBy | undefined;
}) {
  const navigate = useNavigate();
  const access = useAccess();
  const by = breakdownFor(asked, steps);
  const ready = steps.length >= MIN_STEPS;
  // Suggestions are optional; the funnel works without them.
  const events = useQuery(productEventsQuery(projectId, range, environment));
  const saved = useQuery(savedFunnelsQuery(projectId));
  // Read for the list only; a funnel shown uses what the list left in the cache.
  const results = useQuery({
    ...savedFunnelResultsQuery(projectId, range, environment),
    enabled: !ready && (saved.data?.length ?? 0) > 0,
  });
  const listed =
    ready && results.data !== undefined && !results.isPlaceholderData
      ? results.data.funnels.find((item) =>
          isShownFunnel(
            {
              steps: item.steps.map((result) => result.step),
              count: item.count,
              window: item.window,
            },
            { steps, count, window },
          ),
        )
      : undefined;
  const query = useQuery({
    ...funnelQuery(projectId, range, environment, steps, count, window),
    enabled: ready,
    // Show the list's counts at once, dimmed, until the answer with the comparison arrives.
    placeholderData: (previous) =>
      listed === undefined || results.data === undefined
        ? previous
        : {
            timeZone: results.data.timeZone,
            environment: results.data.environment,
            firstDay: results.data.firstDay,
            lastDay: results.data.lastDay,
            environments: previous?.environments ?? events.data?.environments ?? [environment],
            count: listed.count,
            window: listed.window,
            steps: listed.steps,
          },
  });
  const times = useQuery({
    ...funnelTimesQuery(projectId, range, environment, steps, count, window),
    enabled: ready,
  });
  const [editing, setEditing] = React.useState<"new" | "edit" | null>(null);
  // Saved goals for the editor's "Copy from a goal" menus; read once it opens.
  const goals = useQuery({ ...goalsQuery(projectId), enabled: editing !== null });
  const [people, setPeople] = React.useState<PeopleList | null>(null);
  // Saving removes the trigger, so return focus to the funnel's heading.
  const titleRef = React.useRef<HTMLHeadingElement>(null);
  const search: FunnelSearch = { range, environment, funnel, steps, count, window, by };
  const show = (next: Partial<FunnelSearch>) => {
    const shown = { ...search, ...next };
    void navigate({
      to: "/projects/$projectId/product/funnel",
      params: { projectId },
      // A property of step 1's event only while step 1 stays that event.
      search: funnelSearchOf({
        ...shown,
        by:
          JSON.stringify(shown.steps[0]) === JSON.stringify(steps[0])
            ? shown.by
            : breakdownFor(shown.by, []),
      }),
    });
  };

  if (
    (query.error instanceof ApiError && query.error.status === 404) ||
    (events.error instanceof ApiError && events.error.status === 404) ||
    (saved.error instanceof ApiError && saved.error.status === 404) ||
    (results.error instanceof ApiError && results.error.status === 404)
  ) {
    return <NoSuchProject />;
  }
  const data = ready ? query.data : undefined;
  const eventNames = events.data?.events.map((event) => event.name) ?? [];
  const example: FunnelStep[] = [
    { type: "page", path: "/" },
    { type: "event", name: eventNames[0] ?? "signup" },
  ];
  const open = saved.data?.find((item) => item.id === funnel);
  const listSearch = productSearchOf({ range, environment });

  const editor = (
    <FunnelEditorDialog
      open={editing !== null}
      onOpenChange={(next) => {
        if (!next) setEditing(null);
      }}
      title={editing === "edit" ? "Edit the funnel's steps" : "New funnel"}
      initial={
        editing === "edit"
          ? { steps, count, window }
          : { steps: [], count: DEFAULT_FUNNEL_COUNT, window: DEFAULT_FUNNEL_WINDOW }
      }
      eventNames={eventNames}
      goals={goals.data}
      // A new funnel leaves the one shown, so saving it makes a new saved funnel.
      onShow={(draft) => show(editing === "edit" ? draft : { ...draft, funnel: undefined })}
    />
  );

  const filterBar = (
    <ReportFilterBar
      range={range}
      environment={environment}
      answered={data ?? events.data}
      onRange={(next) => show({ range: next })}
      onEnvironment={(next) => show({ environment: next })}
      actions={
        !ready && (saved.data?.length ?? 0) > 0 ? (
          <WorkbenchKeyHints hints={SAVED_FUNNEL_KEYS} />
        ) : undefined
      }
    />
  );

  if (!ready) {
    return (
      <div className="flex flex-col">
        {filterBar}
        <div className="flex flex-col gap-6 px-gutter py-5">
          {saved.data !== undefined && saved.data.length === 0 && !saved.isError ? (
            <NoFunnels
              example={example}
              onNew={() => setEditing("new")}
              onExample={() => show({ steps: example, funnel: undefined })}
            />
          ) : (
            <SavedFunnelsCard
              projectId={projectId}
              funnels={saved.data}
              results={results}
              failure={saved.isError ? saved.error.message : null}
              onRetry={() => void saved.refetch()}
              search={search}
              openId={funnel}
              onDeleted={(deleted) => {
                if (deleted.id === funnel) show({ funnel: undefined });
              }}
              action={
                <Button size="sm" onClick={() => setEditing("new")}>
                  <PlusIcon data-icon="inline-start" />
                  New funnel
                </Button>
              }
            />
          )}
        </div>
        {editor}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {filterBar}
      <div className="flex flex-col gap-6 px-gutter py-5">
        <section aria-labelledby="funnel-title" className="flex flex-col gap-3">
          <Link
            to="/projects/$projectId/product/funnel"
            params={{ projectId }}
            search={listSearch}
            className="inline-flex w-fit items-center gap-1 text-sm text-ink-subtle hover:text-ink"
          >
            <ArrowLeftIcon aria-hidden="true" className="size-4" />
            All funnels
          </Link>
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
            <div className="flex min-w-0 flex-col gap-1">
              <h2
                id="funnel-title"
                ref={titleRef}
                tabIndex={-1}
                className="text-base font-medium text-ink outline-none"
              >
                {open?.name ??
                  (funnel !== undefined && saved.isPending ? "Funnel" : "Unsaved funnel")}
              </h2>
              <p className="min-w-0 text-sm break-words text-ink-subtle">
                {stepsLine(steps)} · {countLine(count, window)}
              </p>
            </div>
            <div className="flex flex-wrap items-start justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditing("edit")}>
                <PencilIcon data-icon="inline-start" />
                Edit steps
              </Button>
              <WhenAllowed area="product_analytics" level="manage">
                <SaveFunnelActions
                  projectId={projectId}
                  shown={{ steps, count, window }}
                  funnels={saved.data}
                  loading={saved.isPending}
                  openId={funnel}
                  returnFocus={titleRef}
                  onSaved={(created) => show({ funnel: created.id })}
                />
              </WhenAllowed>
            </div>
          </div>
        </section>
        {query.isError && (
          <LoadFailed
            what="The funnel"
            message={query.error.message}
            hasData={data !== undefined}
            onRetry={() => void query.refetch()}
          />
        )}
        {data === undefined ? (
          !query.isError && (
            <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading">
              <div className="grid max-w-2xl grid-cols-3 gap-4">
                {["conversion", "first", "last"].map((item) => (
                  <div key={item} className="flex flex-col gap-2">
                    <Skeleton className="h-3 w-20" />
                    <Skeleton className="h-7 w-16" />
                  </div>
                ))}
              </div>
              <Skeleton className="h-40 w-full" />
            </div>
          )
        ) : (
          <Refreshing stale={query.isPlaceholderData}>
            <FunnelResults
              funnel={data}
              times={{
                data: times.isPlaceholderData ? undefined : times.data,
                loading: times.isFetching,
              }}
              onPeople={access.canUse("users") ? setPeople : undefined}
            />
          </Refreshing>
        )}
        <FunnelTrendSection
          projectId={projectId}
          range={range}
          environment={environment}
          steps={steps}
          count={count}
          window={window}
        />
        <FunnelBreakdownSection
          projectId={projectId}
          range={range}
          environment={environment}
          steps={steps}
          count={count}
          window={window}
          by={by}
          onBy={(next) => show({ by: next })}
        />
        <FunnelNotes window={window} />
      </div>
      {editor}
      <FunnelPeopleDialog
        list={people}
        onClose={() => setPeople(null)}
        projectId={projectId}
        range={range}
        environment={environment}
        steps={steps}
        window={window}
        timeZone={data?.timeZone ?? "UTC"}
      />
    </div>
  );
}
