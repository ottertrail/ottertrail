import { useQuery } from "@tanstack/react-query";
import type { RouterHistory } from "@tanstack/react-router";
import { LinkIcon, OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { AvatarSquare } from "@/components/avatar-square";
import { ButtonAnchor } from "@/components/button-anchor";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { AnalyticsView } from "@/features/analytics/analytics-page";
import { formatWhole } from "@/features/analytics/format";
import { type PageSearch, searchOf } from "@/features/analytics/list-rows";
import { LiveDot } from "@/features/analytics/now-indicator";
import { type AnalyticsScope, AnalyticsScopeContext } from "@/features/analytics/scope";
import {
  analyticsRangeFrom,
  DEFAULT_COMPARISON,
  filtersFrom,
  isChartInterval,
  isComparison,
} from "@/lib/analytics-api";
import { type ReportSource, sharedReports } from "@/lib/analytics-queries";
import { ApiError } from "@/lib/api";
import { initialOf } from "@/lib/initials";
import { nowQuery } from "@/lib/now-api";
import { sharedPageQuery } from "@/lib/share-links-api";

/*
 * A shared link's page (docs/web-analytics.md, "Shared links"): one
 * project's Web analytics, read-only, for anyone with the link. Its own
 * entry (share.html), so it loads none of the signed-in dashboard's code:
 * no router, session, sidebar, or access checks. The reports are the
 * dashboard's own components, through the shared link's scope.
 */

/** The page's address for `search`: the link's path, the period, filters, and goal. */
function hrefOf(pathname: string, search: PageSearch): string {
  // The link names its environment; the address never does.
  const { env: _env, ...params } = searchOf(search) as Record<
    string,
    string | string[] | undefined
  >;
  const query = new URLSearchParams();
  // A filter's values repeat its parameter: country=DE&country=FR.
  for (const [key, value] of Object.entries(params)) {
    for (const item of [value ?? []].flat()) query.append(key, item);
  }
  const text = query.toString();
  return text === "" ? pathname : `${pathname}?${text}`;
}

/** Whether a click should open the link in this tab: not one asking for a new tab or window. */
const plainClick = (event: React.MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

function useSearch(history: RouterHistory): string {
  return React.useSyncExternalStore(
    (changed) => history.subscribe(changed),
    () => history.location.search,
  );
}

/** "3 visitors now": the dashboard's live count, without its link to Right now. */
function LiveCount({ source, environment }: { source: ReportSource; environment: string }) {
  const now = useQuery(nowQuery(source, environment));
  if (now.data === undefined) return null;
  const { visitors } = now.data;
  return (
    <p className="inline-flex h-8 items-center gap-2 rounded-md border px-3 text-sm whitespace-nowrap text-ink tabular-nums">
      <LiveDot live={visitors > 0} />
      {visitors === 0
        ? "No visitors now"
        : `${formatWhole(visitors)} ${visitors === 1 ? "visitor" : "visitors"} now`}
    </p>
  );
}

function LinkGone() {
  return (
    <Empty className="m-gutter border border-dashed p-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <LinkIcon />
        </EmptyMedia>
        <EmptyTitle>This link does not work</EmptyTitle>
        <EmptyDescription>
          It may have been revoked, or copied incompletely. Ask whoever sent it for a new one.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function Frame({
  title,
  icon,
  actions,
  children,
}: {
  title: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    // The dashboard's surface, as its inset has: pinned cells and the filter bar paint it too.
    <div className="flex min-h-svh flex-col bg-background">
      <header className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 px-gutter py-3">
        {icon}
        <h1 className="min-w-0 text-base font-semibold text-pretty text-ink">{title}</h1>
        {actions !== undefined && <div className="ms-auto">{actions}</div>}
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t px-gutter py-4 text-xs text-ink-subtle">
        Shared with Ottertrail. Read-only.
      </footer>
    </div>
  );
}

/** An address under /share/ that holds no token. */
export function NoLink() {
  return (
    <Frame title="Web analytics">
      <LinkGone />
    </Frame>
  );
}

export function ShareApp({ token, history }: { token: string; history: RouterHistory }) {
  const page = useQuery(sharedPageQuery(token));
  const search = useSearch(history);
  const { pathname } = history.location;
  const source = React.useMemo(() => sharedReports(token), [token]);

  const scope = React.useMemo(
    (): AnalyticsScope => ({
      source,
      renderLink: ({ search: next, button, onClick, children, ...props }) => {
        const href = hrefOf(pathname, next);
        const open = (event: React.MouseEvent) => {
          onClick?.();
          if (!plainClick(event)) return;
          event.preventDefault();
          history.push(href);
        };
        return button === undefined ? (
          <a href={href} onClick={open} {...props}>
            {children}
          </a>
        ) : (
          <ButtonAnchor href={href} onClick={open} {...props} {...button}>
            {children}
          </ButtonAnchor>
        );
      },
      show: (next) => history.push(hrefOf(pathname, next)),
      renderHeaderActions: () => null,
      notFound: <LinkGone />,
      dashboard: null,
    }),
    [source, history, pathname],
  );

  const name = page.data?.project.name;
  React.useEffect(() => {
    document.title = name === undefined ? "Web analytics" : `${name}: Web analytics`;
  }, [name]);

  if (page.isPending) {
    return (
      <Frame title={<Skeleton className="h-5 w-40" />}>
        <div className="flex flex-col gap-4 px-gutter py-5" aria-busy="true">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-44 w-full" />
        </div>
      </Frame>
    );
  }
  if (page.isError) {
    return (
      <Frame title="Web analytics">
        {page.error instanceof ApiError && page.error.status === 404 ? (
          <LinkGone />
        ) : (
          <div className="px-gutter py-5">
            <Alert variant="destructive">
              <OctagonAlertIcon />
              <AlertTitle>The page could not load</AlertTitle>
              <AlertDescription>{page.error.message}</AlertDescription>
              <AlertAction>
                <Button variant="outline" size="sm" onClick={() => void page.refetch()}>
                  Retry
                </Button>
              </AlertAction>
            </Alert>
          </div>
        )}
      </Frame>
    );
  }

  const { project, environment } = page.data;
  const params = new URLSearchParams(search);
  const raw = Object.fromEntries(params);
  const lists = Object.fromEntries([...params.keys()].map((key) => [key, params.getAll(key)]));
  return (
    <AnalyticsScopeContext value={scope}>
      <Frame
        icon={<AvatarSquare src={project.iconUrl} text={initialOf(project.name)} />}
        title={
          <>
            {project.name}
            <span className="font-normal text-ink-subtle"> · Web analytics</span>
          </>
        }
        actions={<LiveCount source={source} environment={environment} />}
      >
        <AnalyticsView
          range={analyticsRangeFrom(raw)}
          filters={filtersFrom(lists)}
          environment={environment}
          goalSearch={{ goal: raw.goal, goalEvent: raw.goalEvent }}
          interval={isChartInterval(raw.interval) ? raw.interval : undefined}
          comparison={isComparison(raw.compare) ? raw.compare : DEFAULT_COMPARISON}
        />
      </Frame>
    </AnalyticsScopeContext>
  );
}
