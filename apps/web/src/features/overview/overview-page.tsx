import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LayoutDashboardIcon, OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { ButtonLink } from "@/components/button-link";
import { FilterBar, FilterBarRange } from "@/components/filter-bar";
import { PageActions } from "@/components/page-header";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { formatDayRange } from "@/features/analytics/format";
import { AREA_LABELS, AREA_PAGES, canUse, meQuery } from "@/lib/access";
import { DEFAULT_ENVIRONMENT } from "@/lib/analytics-api";
import {
  DEFAULT_OVERVIEW_PERIOD,
  isOverviewPeriod,
  type Layout,
  layoutQuery,
  OVERVIEW_PERIODS,
  type OverviewPeriod,
  resetLayout,
  saveLayout,
  type WidgetId,
  widgetQuery,
  widgetTitle,
} from "@/lib/overview-api";

import { periodDays } from "./format";
import {
  AttentionWidget,
  ErrorsWidget,
  GoalsWidget,
  MainGoalWidget,
  ServicesWidget,
  SourcesWidget,
  SpeedWidget,
  TrafficWidget,
  UptimeWidget,
  UsersWidget,
  type WidgetProps,
} from "./widgets";

const WIDGET_COMPONENTS: Record<WidgetId, (props: WidgetProps) => React.ReactNode> = {
  attention: AttentionWidget,
  errors: ErrorsWidget,
  uptime: UptimeWidget,
  services: ServicesWidget,
  speed: SpeedWidget,
  "main-goal": MainGoalWidget,
  traffic: TrafficWidget,
  goals: GoalsWidget,
  users: UsersWidget,
  sources: SourcesWidget,
};

/** Nothing on the overview: none of its areas. Points to the pages the user can open. */
function NothingHere({ projectId }: { projectId: string }) {
  const me = useQuery(meQuery()).data;
  const pages = AREA_PAGES.filter(([area]) => canUse(me, area));
  return (
    <Empty className="m-6 border border-dashed p-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <LayoutDashboardIcon />
        </EmptyMedia>
        <EmptyTitle>Nothing on your overview</EmptyTitle>
        <EmptyDescription>
          The overview sums up errors, uptime, monitoring, and analytics, and your access covers
          none of them.
          {pages.length > 0 ? " These pages are open to you:" : " Ask an admin if you need access."}
        </EmptyDescription>
      </EmptyHeader>
      {pages.length > 0 && (
        <EmptyContent className="flex-row flex-wrap justify-center">
          {pages.map(([area, to]) => (
            <ButtonLink key={area} variant="outline" size="sm" to={to} params={{ projectId }}>
              {AREA_LABELS[area].name}
            </ButtonLink>
          ))}
        </EmptyContent>
      )}
    </Empty>
  );
}

/**
 * The project overview (docs/dashboard.md, "Overview"): the widgets the
 * user may see, in their own order, each loading and failing on its own.
 * "Edit overview" moves, hides, and shows them; every change is saved at
 * once, for this user and project only, and announced.
 */
export function OverviewPage({
  projectId,
  period = DEFAULT_OVERVIEW_PERIOD,
  environment = DEFAULT_ENVIRONMENT,
}: {
  projectId: string;
  period?: OverviewPeriod;
  environment?: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useQuery(meQuery()).data;
  const layout = useQuery(layoutQuery(projectId));
  const [editing, setEditing] = React.useState(false);
  const [announcement, setAnnouncement] = React.useState("");
  /** After a move, the button to keep focus on: the widget and the direction. */
  const focusAfter = React.useRef<{ id: WidgetId; move: "up" | "down" } | null>(null);
  const editButton = React.useRef<HTMLButtonElement>(null);
  const widgetsRef = React.useRef<HTMLDivElement>(null);

  const layoutKey = layoutQuery(projectId).queryKey;
  /**
   * The latest change asked for. Saves and resets of one project run one
   * after another (one mutation scope), and only the latest one's answer is
   * shown: an earlier answer arriving after a newer change would undo it.
   */
  const latest = React.useRef(0);
  const scope = { id: `overview-layout-${projectId}` };
  const save = useMutation({
    scope,
    mutationFn: ({ layout: next }: { layout: Layout; change: number }) =>
      saveLayout(projectId, {
        order: next.widgets.map((widget) => widget.id),
        hidden: next.widgets.filter((widget) => widget.hidden).map((widget) => widget.id),
      }),
    onMutate: () => queryClient.cancelQueries({ queryKey: layoutKey }),
    onSuccess: (saved, { change }) => {
      if (change === latest.current) queryClient.setQueryData(layoutKey, saved);
    },
    onError: (_error, { change }) => {
      if (change === latest.current) void queryClient.invalidateQueries({ queryKey: layoutKey });
    },
  });
  const reset = useMutation({
    scope,
    mutationFn: (_change: number) => resetLayout(projectId),
    onMutate: () => queryClient.cancelQueries({ queryKey: layoutKey }),
    onSuccess: (saved, change) => {
      if (change === latest.current) queryClient.setQueryData(layoutKey, saved);
      setAnnouncement("The default layout is back.");
    },
  });

  /** Shows a new layout at once, and saves it after any save still running. */
  function applyLayout(next: Layout) {
    latest.current += 1;
    void queryClient.cancelQueries({ queryKey: layoutKey });
    queryClient.setQueryData(layoutKey, next);
    save.mutate({ layout: next, change: latest.current });
  }

  React.useLayoutEffect(() => {
    const target = focusAfter.current;
    if (target === null) return;
    focusAfter.current = null;
    const section = widgetsRef.current?.querySelector(`[data-widget="${target.id}"]`);
    const wanted = section?.querySelector<HTMLButtonElement>(`[data-move="${target.move}"]`);
    // At the top or bottom, that button is disabled: focus the other one.
    (wanted?.disabled === false
      ? wanted
      : section?.querySelector<HTMLButtonElement>("[data-move]:not(:disabled)")
    )?.focus();
  });

  function startEditing(on: boolean) {
    setEditing(on);
    setAnnouncement("");
    if (!on) {
      requestAnimationFrame(() => editButton.current?.focus());
    }
  }

  // The days as the API counts them, from the first widget shown (the same
  // request the widget makes); until it answers, as this browser works them out.
  const firstShown = layout.data?.widgets.find((widget) => !widget.hidden)?.id ?? "traffic";
  const first = useQuery({
    ...widgetQuery(projectId, firstShown, period, environment),
    enabled: layout.data?.widgets.some((widget) => !widget.hidden) === true,
  });
  const timeZone = first.data?.timeZone ?? me?.instance.timeZone ?? "UTC";
  const days = first.data ?? periodDays(period, timeZone);
  const hasArea = me !== undefined && layout.data !== undefined && layout.data.widgets.length > 0;

  const filterBar = (
    <FilterBar
      label="Period and environment"
      period={
        <Select
          items={OVERVIEW_PERIODS}
          value={period}
          onValueChange={(value) => {
            if (!isOverviewPeriod(value)) return;
            void navigate({
              to: "/projects/$projectId/overview",
              params: { projectId },
              search: (previous) => ({
                ...previous,
                period: value === DEFAULT_OVERVIEW_PERIOD ? undefined : value,
              }),
            });
          }}
        >
          <SelectTrigger aria-label="Period" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OVERVIEW_PERIODS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
      environment={
        <span className="text-sm whitespace-nowrap text-ink-subtle">
          Environment <span className="text-ink">{environment}</span>
        </span>
      }
      filters={
        <span className="text-sm whitespace-nowrap text-ink-subtle">
          Compared with{" "}
          <span className="text-ink tabular-nums">
            {formatDayRange(days.previous.firstDay, days.previous.lastDay)}
          </span>
        </span>
      }
      range={<FilterBarRange firstDay={days.firstDay} lastDay={days.lastDay} timeZone={timeZone} />}
    />
  );
  // The page's action, in its header.
  const editAction = hasArea && (
    <PageActions>
      <Button
        ref={editButton}
        type="button"
        variant="outline"
        aria-expanded={editing}
        aria-controls="overview-edit-bar"
        onClick={() => startEditing(!editing)}
      >
        Edit overview
      </Button>
    </PageActions>
  );

  if (layout.isPending || me === undefined) {
    return (
      <>
        {filterBar}
        {/* Two columns by the content's width, not the window's: the sidebar takes 16rem. */}
        <div className="@container">
          <div aria-busy="true" className="grid gap-x-10 gap-y-8 px-gutter py-6 @5xl:grid-cols-2">
            {Array.from({ length: 4 }, (_, index) => (
              // oxlint-disable-next-line react/no-array-index-key
              <Skeleton key={index} className="h-48 w-full" />
            ))}
          </div>
        </div>
      </>
    );
  }
  if (layout.isError) {
    return (
      <>
        {filterBar}
        <div className="px-gutter py-6">
          <Alert variant="destructive">
            <OctagonAlertIcon />
            <AlertTitle>The overview could not load</AlertTitle>
            <AlertDescription>{layout.error.message}</AlertDescription>
            <AlertAction>
              <Button variant="outline" size="sm" onClick={() => void layout.refetch()}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        </div>
      </>
    );
  }
  if (layout.data.widgets.length === 0) {
    return <NothingHere projectId={projectId} />;
  }

  const { widgets } = layout.data;
  const shown = editing ? widgets : widgets.filter((widget) => !widget.hidden);

  /** The layout as last changed: the cache, which a quick second click may be ahead of the page in. */
  const current = () => queryClient.getQueryData<Layout>(layoutKey)?.widgets ?? widgets;

  function move(id: WidgetId, by: -1 | 1) {
    const now = current();
    const from = now.findIndex((widget) => widget.id === id);
    const to = from + by;
    const moving = now[from];
    if (moving === undefined || to < 0 || to >= now.length) return;
    const next = now.toSpliced(from, 1).toSpliced(to, 0, moving);
    focusAfter.current = { id, move: by === -1 ? "up" : "down" };
    applyLayout({ widgets: next, isDefault: false });
    setAnnouncement(`${widgetTitle(id)} moved to ${to + 1} of ${now.length}.`);
  }

  function toggle(id: WidgetId) {
    const next = current().map((widget) =>
      widget.id === id ? { ...widget, hidden: !widget.hidden } : widget,
    );
    applyLayout({ widgets: next, isDefault: false });
    const hidden = next.find((widget) => widget.id === id)?.hidden === true;
    setAnnouncement(`${widgetTitle(id)} ${hidden ? "hidden" : "shown"}.`);
  }

  return (
    <>
      {editAction}
      {filterBar}
      {editing && (
        <div
          id="overview-edit-bar"
          className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-muted/40 px-gutter py-2"
        >
          <p className="text-sm text-ink-muted">
            Show, hide and order the widgets. The layout is yours alone, for this project.
          </p>
          <output aria-live="polite" className="text-sm text-ink">
            {save.isError
              ? `The layout could not be saved: ${save.error.message}`
              : reset.isError
                ? `The layout could not be reset: ${reset.error.message}`
                : announcement}
          </output>
          <div className="flex gap-2 sm:ml-auto">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={layout.data.isDefault || reset.isPending}
              onClick={() => {
                latest.current += 1;
                reset.mutate(latest.current);
              }}
            >
              Reset to default
            </Button>
            <Button type="button" size="sm" onClick={() => startEditing(false)}>
              Done
            </Button>
          </div>
        </div>
      )}
      {shown.length === 0 ? (
        <Empty className="m-6 border border-dashed p-10">
          <EmptyHeader>
            <EmptyTitle>Every widget is hidden</EmptyTitle>
            <EmptyDescription>Edit the overview to show them again.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button type="button" variant="outline" size="sm" onClick={() => startEditing(true)}>
              Edit overview
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="@container">
          <div
            ref={widgetsRef}
            // Each widget draws a line above it, except the first row: the filter bar's
            // (or the edit bar's) line is already there.
            className="grid grid-cols-1 gap-x-10 gap-y-8 px-gutter pt-2 pb-8 @5xl:grid-cols-2 [&>*:first-child]:border-t-0 @5xl:[&>*:nth-child(2)]:border-t-0"
          >
            {shown.map((widget) => {
              const Widget = WIDGET_COMPONENTS[widget.id];
              const index = widgets.findIndex((item) => item.id === widget.id);
              return (
                <Widget
                  key={widget.id}
                  projectId={projectId}
                  period={period}
                  environment={environment}
                  arrange={
                    editing
                      ? {
                          index,
                          count: widgets.length,
                          hidden: widget.hidden,
                          onMove: (by) => move(widget.id, by),
                          onToggle: () => toggle(widget.id),
                        }
                      : undefined
                  }
                />
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
