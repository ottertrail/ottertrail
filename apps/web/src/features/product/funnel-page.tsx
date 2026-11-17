import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { FilterIcon } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { DEFAULT_ENVIRONMENT, type PageRange } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import { savedFunnelsQuery } from "@/lib/funnels-api";
import {
  FUNNEL_COUNTS,
  FUNNEL_WINDOWS,
  type FunnelCount,
  type FunnelStep,
  type FunnelWindow,
  funnelQuery,
  isFunnelCount,
  isFunnelWindow,
  MAX_VISITOR_WINDOW,
  MIN_STEPS,
  productEventsQuery,
  windowAllowed,
} from "@/lib/product-api";

import { RangeControls } from "../errors/range-controls";
import { NoSuchProject } from "../projects/no-such-project";
import { windowLabel } from "./format";
import { FunnelEditor } from "./funnel-editor";
import { FunnelResults } from "./funnel-results";
import { stepText } from "./funnel-steps";
import { LoadFailed, Refreshing } from "./report-state";
import { SaveFunnelActions } from "./save-funnel-actions";
import { SavedFunnelsCard } from "./saved-funnels-card";
import { type FunnelSearch, funnelSearchOf } from "./search";

/** Who to count, and for how long after step 1. Applies at once. */
function FunnelSettings({
  count,
  window,
  onChange,
}: {
  count: FunnelCount;
  window: FunnelWindow;
  onChange: (next: { count: FunnelCount; window: FunnelWindow }) => void;
}) {
  return (
    <div className="flex flex-wrap items-start gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-ink-subtle" aria-hidden="true">
          Count by
        </span>
        <Select
          items={FUNNEL_COUNTS}
          value={count}
          onValueChange={(value) => {
            if (!isFunnelCount(value)) return;
            // Visitors cannot be followed past a day: shorten a longer window.
            onChange({
              count: value,
              window: windowAllowed(value, window) ? window : MAX_VISITOR_WINDOW,
            });
          }}
        >
          <SelectTrigger aria-label="Count by" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FUNNEL_COUNTS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-ink-subtle" aria-hidden="true">
          Conversion window
        </span>
        <Select
          items={FUNNEL_WINDOWS.map((item) => ({ value: item.value, label: item.label }))}
          value={window}
          onValueChange={(value) => {
            if (isFunnelWindow(value)) onChange({ count, window: value });
          }}
        >
          <SelectTrigger aria-label="Conversion window" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FUNNEL_WINDOWS.map((item) => (
              <SelectItem
                key={item.value}
                value={item.value}
                disabled={!windowAllowed(count, item.value)}
              >
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {count === "visitors" && (
        <p className="max-w-sm self-end pb-1.5 text-xs text-ink-subtle">
          Windows over a day need Users: a visitor&apos;s ID changes every day.
        </p>
      )}
    </div>
  );
}

/** The definitions the funnel counts by (docs/product-analytics.md, "Funnel"). */
function FunnelNotes({ window }: { window: FunnelWindow }) {
  return (
    <section aria-labelledby="funnel-notes" className="flex flex-col gap-2">
      <h3 id="funnel-notes" className="text-sm font-medium text-ink">
        How the funnel counts
      </h3>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-xs text-ink-subtle">
        <li>
          Someone reaches a step when they did every step before it, in order. Other events in
          between are allowed.
        </li>
        <li>
          Every step must happen within the conversion window ({windowLabel(window)}), counted from
          their step 1.
        </li>
        <li>
          Step 1 must happen in the chosen period; the later steps may happen after it ends, within
          the window.
        </li>
        <li>
          Visitors can be followed for a day at most: their IDs change every day, so a visitor who
          comes back tomorrow is someone new. Users are your site&apos;s IDs for signed-in users,
          followed for up to 30 days, but only events sent while someone was signed in count.
        </li>
        <li>
          A page step is a pageview of exactly that path. An event step&apos;s property filter
          compares the value as text: a number, true, false, or null as JSON writes it.
        </li>
      </ul>
    </section>
  );
}

/** Until two steps are shown: what a funnel is, with an example to start from. */
function StartHere({ example, onUse }: { example: FunnelStep[]; onUse: () => void }) {
  return (
    <Empty className="border border-dashed p-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FilterIcon />
        </EmptyMedia>
        <EmptyTitle>Build a funnel</EmptyTitle>
        <EmptyDescription>
          Set two to five steps above, each an event your site sends or a page, then choose Show
          funnel to see how many people went from each step to the next. For example:{" "}
          {example.map((step, index) => (
            <span key={index}>
              {index > 0 && " then "}
              {step.type === "page" ? "the page " : "the event "}
              <code className="font-mono">{stepText(step)}</code>
            </span>
          ))}
          .
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" onClick={onUse}>
          Use this example
        </Button>
      </EmptyContent>
    </Empty>
  );
}

/**
 * One ordered funnel: of the people who did step 1 in the period, how many
 * went on to each next step, in order, within the conversion window. The
 * steps, the count, and the window live in the address, with the saved
 * funnel last opened or saved, if any; the project's saved funnels are
 * listed above the steps.
 */
export function FunnelPage({
  projectId,
  range,
  environment = DEFAULT_ENVIRONMENT,
  funnel,
  steps,
  count,
  window,
}: {
  projectId: string;
  range: PageRange;
  environment?: string;
  /** The saved funnel open in the address, by ID. */
  funnel?: string | undefined;
  steps: FunnelStep[];
  count: FunnelCount;
  window: FunnelWindow;
}) {
  const navigate = useNavigate();
  const ready = steps.length >= MIN_STEPS;
  const query = useQuery({
    ...funnelQuery(projectId, range, environment, steps, count, window),
    enabled: ready,
  });
  // The project's event names, to suggest; the funnel works without them.
  const events = useQuery(productEventsQuery(projectId, range, environment));
  const saved = useQuery(savedFunnelsQuery(projectId));
  // Where focus goes once the shown funnel is saved: the button that did it is gone.
  const stepsHeadingRef = React.useRef<HTMLHeadingElement>(null);
  const search: FunnelSearch = { range, environment, funnel, steps, count, window };
  const show = (next: Partial<FunnelSearch>) =>
    void navigate({
      to: "/projects/$projectId/product/funnel",
      params: { projectId },
      search: funnelSearchOf({ ...search, ...next }),
    });

  if (
    (query.error instanceof ApiError && query.error.status === 404) ||
    (events.error instanceof ApiError && events.error.status === 404) ||
    (saved.error instanceof ApiError && saved.error.status === 404)
  ) {
    return <NoSuchProject />;
  }
  const data = ready ? query.data : undefined;
  const eventNames = events.data?.events.map((event) => event.name) ?? [];
  const example: FunnelStep[] = [
    { type: "page", path: "/" },
    { type: "event", name: eventNames[0] ?? "signup" },
  ];

  return (
    <div className="flex flex-col gap-4">
      <RangeControls
        range={range}
        environment={environment}
        answered={data ?? events.data}
        onRange={(next) => show({ range: next })}
        onEnvironment={(next) => show({ environment: next })}
      />
      <SavedFunnelsCard
        projectId={projectId}
        funnels={saved.data}
        failure={saved.isError ? saved.error.message : null}
        onRetry={() => void saved.refetch()}
        search={search}
        openId={funnel}
        onDeleted={(deleted) => {
          // The shown steps stay; they are just no longer saved.
          if (deleted.id === funnel) show({ funnel: undefined });
        }}
      />
      <Card>
        <CardHeader>
          <CardTitle>
            <h3 ref={stepsHeadingRef} tabIndex={-1} className="outline-none">
              Steps
            </h3>
          </CardTitle>
          {ready && (
            <CardAction>
              <SaveFunnelActions
                projectId={projectId}
                shown={{ steps, count, window }}
                funnels={saved.data}
                loading={saved.isPending}
                openId={funnel}
                returnFocus={stepsHeadingRef}
                onSaved={(created) => show({ funnel: created.id })}
              />
            </CardAction>
          )}
        </CardHeader>
        <CardContent>
          <FunnelEditor
            applied={steps}
            eventNames={eventNames}
            onApply={(next) => show({ steps: next })}
          >
            <FunnelSettings count={count} window={window} onChange={(next) => show({ ...next })} />
          </FunnelEditor>
        </CardContent>
      </Card>
      {!ready ? (
        <StartHere example={example} onUse={() => show({ steps: example })} />
      ) : (
        <>
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
              <Skeleton className="h-72 w-full rounded-xl" aria-busy="true" aria-label="Loading" />
            )
          ) : (
            <Refreshing stale={query.isPlaceholderData}>
              <FunnelResults funnel={data} />
            </Refreshing>
          )}
        </>
      )}
      <FunnelNotes window={window} />
    </div>
  );
}
