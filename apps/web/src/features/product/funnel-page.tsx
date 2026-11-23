import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { FilterIcon } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { WhenAllowed } from "@/components/when-allowed";
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

import { ReportFilterBar } from "../errors/range-controls";
import { NoSuchProject } from "../projects/no-such-project";
import { windowLabel } from "./format";
import { FunnelEditor } from "./funnel-editor";
import { FunnelResults } from "./funnel-results";
import { stepText } from "./funnel-steps";
import { LoadFailed, Refreshing } from "./report-state";
import { SaveFunnelActions } from "./save-funnel-actions";
import { SavedFunnelsCard } from "./saved-funnels-card";
import { type FunnelSearch, funnelSearchOf } from "./search";

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
          Windows longer than a day require Users. A visitor's ID changes every day.
        </p>
      )}
    </div>
  );
}

/** The definitions the funnel counts by (docs/product-analytics.md, "Funnel"). */
function FunnelNotes({ window }: { window: FunnelWindow }) {
  return (
    <section aria-labelledby="funnel-notes" className="flex flex-col gap-2 border-t pt-5">
      <h2 id="funnel-notes" className="text-sm font-medium text-ink">
        How the funnel counts
      </h2>
      <ul className="flex max-w-4xl list-disc flex-col gap-1 pl-5 text-xs text-pretty text-ink-subtle">
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
      </ul>
    </section>
  );
}

function StartHere({ example, onUse }: { example: FunnelStep[]; onUse: () => void }) {
  return (
    <Empty className="border border-dashed p-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FilterIcon />
        </EmptyMedia>
        <EmptyTitle>Build a funnel</EmptyTitle>
        <EmptyDescription>
          Set two to five steps above. Each step is a page or an event your site sends. Select Show
          funnel to see how many people reached each successive step. For example:{" "}
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
  // Suggestions are optional; the funnel works without them.
  const events = useQuery(productEventsQuery(projectId, range, environment));
  const saved = useQuery(savedFunnelsQuery(projectId));
  // Saving removes the trigger, so return focus to the Steps heading.
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
    <div className="flex flex-col">
      <ReportFilterBar
        range={range}
        environment={environment}
        answered={data ?? events.data}
        onRange={(next) => show({ range: next })}
        onEnvironment={(next) => show({ environment: next })}
      />
      <div className="flex flex-col gap-6 px-gutter py-5">
        <SavedFunnelsCard
          projectId={projectId}
          funnels={saved.data}
          failure={saved.isError ? saved.error.message : null}
          onRetry={() => void saved.refetch()}
          search={search}
          openId={funnel}
          onDeleted={(deleted) => {
            if (deleted.id === funnel) show({ funnel: undefined });
          }}
        />
        <section aria-labelledby="funnel-steps" className="flex flex-col gap-4 border-t pt-5">
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <h2
              id="funnel-steps"
              ref={stepsHeadingRef}
              tabIndex={-1}
              className="py-1.5 text-sm font-medium text-ink outline-none"
            >
              Steps
            </h2>
            <WhenAllowed area="product_analytics" level="manage">
              <SaveFunnelActions
                projectId={projectId}
                shown={ready ? { steps, count, window } : null}
                funnels={saved.data}
                loading={saved.isPending}
                openId={funnel}
                returnFocus={stepsHeadingRef}
                onSaved={(created) => show({ funnel: created.id })}
              />
            </WhenAllowed>
          </div>
          <FunnelEditor
            applied={steps}
            eventNames={eventNames}
            onApply={(next) => show({ steps: next })}
          >
            <FunnelSettings count={count} window={window} onChange={(next) => show({ ...next })} />
          </FunnelEditor>
        </section>
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
                <FunnelResults funnel={data} />
              </Refreshing>
            )}
          </>
        )}
        <FunnelNotes window={window} />
      </div>
    </div>
  );
}
