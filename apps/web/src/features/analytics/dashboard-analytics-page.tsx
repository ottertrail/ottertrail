import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, MousePointerClickIcon } from "lucide-react";
import * as React from "react";

import { ButtonLink } from "@/components/button-link";
import { PageActions } from "@/components/page-header";
import { useAccess } from "@/lib/access";
import { DEFAULT_ENVIRONMENT, type Filters, type PageRange } from "@/lib/analytics-api";
import { projectReports } from "@/lib/analytics-queries";
import { projectQuery } from "@/lib/projects-api";

import { heatmapsSearchOf } from "../heatmaps/search";
import { productSearchOf } from "../product/search";
import { NoSuchProject } from "../projects/no-such-project";
import { AnalyticsView } from "./analytics-page";
import { type PageSearch, searchOf } from "./list-rows";
import { NowIndicator } from "./now-indicator";
import { type AnalyticsScope, AnalyticsScopeContext, type PageLinkProps } from "./scope";

const actionClass =
  "flex size-6 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-accent hover:text-ink max-sm:size-8";

function HeatmapLink({
  projectId,
  search,
  path,
}: {
  projectId: string;
  search: PageSearch;
  path: string;
}) {
  return (
    <Link
      to="/projects/$projectId/heatmaps"
      params={{ projectId }}
      search={heatmapsSearchOf({
        range: search.range,
        environment: search.environment,
        path,
        device: undefined,
      })}
      aria-label={`Heatmap of ${path}`}
      title={`Heatmap of ${path}`}
      className={actionClass}
    >
      <MousePointerClickIcon aria-hidden="true" className="size-3.5" />
    </Link>
  );
}

/** A custom event's own page, under Product analytics. */
function EventPageLink({
  projectId,
  search,
  name,
}: {
  projectId: string;
  search: PageSearch;
  name: string;
}) {
  return (
    <Link
      to="/projects/$projectId/product/events/$name"
      params={{ projectId, name }}
      search={productSearchOf(search)}
      aria-label={`Open the ${name} event`}
      title={`Open the ${name} event`}
      className={actionClass}
    >
      <ArrowUpRightIcon aria-hidden="true" className="size-3.5" />
    </Link>
  );
}

/** The Web analytics page's own address, with another search. */
function renderPageLink(
  projectId: string,
  { search, button, children, ...props }: PageLinkProps,
): React.ReactNode {
  const target = {
    to: "/projects/$projectId/web-analytics",
    params: { projectId },
    search: searchOf(search),
  } as const;
  return button === undefined ? (
    <Link {...target} {...props}>
      {children}
    </Link>
  ) : (
    <ButtonLink {...target} {...props} {...button}>
      {children}
    </ButtonLink>
  );
}

/**
 * The signed-in dashboard's scope for the Web analytics page and Right now:
 * the project's routes, links to the dashboard's other pages, and what the
 * user may do (scope.ts).
 */
export function DashboardAnalyticsScope({
  projectId,
  children,
}: {
  projectId: string;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const access = useAccess();
  const project = useQuery(projectQuery(projectId));
  const canOpenEvents = access.canUse("product_analytics");
  const canManageGoals = access.canUse("product_analytics", "manage");
  // Installation instructions require project management access.
  const canInstall = access.can("projects");
  const lastEventAt = project.data?.lastEventAt;
  const scope = React.useMemo(
    (): AnalyticsScope => ({
      source: projectReports(projectId),
      renderLink: (props) => renderPageLink(projectId, props),
      show: (search) =>
        void navigate({
          to: "/projects/$projectId/web-analytics",
          params: { projectId },
          search: searchOf(search),
        }),
      renderHeaderActions: (environment) => (
        <PageActions>
          <NowIndicator projectId={projectId} environment={environment} />
        </PageActions>
      ),
      notFound: <NoSuchProject />,
      dashboard: {
        projectId,
        lastEventAt,
        showGoals: canOpenEvents,
        canManageGoals,
        canInstall,
        installLink: (
          <ButtonLink variant="outline" to="/projects/$projectId/settings" params={{ projectId }}>
            Install the snippet
          </ButtonLink>
        ),
        renderHeatmapLink: (search, path) => (
          <HeatmapLink projectId={projectId} search={search} path={path} />
        ),
        renderEventLink: canOpenEvents
          ? (search, name) => <EventPageLink projectId={projectId} search={search} name={name} />
          : null,
      },
    }),
    [projectId, navigate, canOpenEvents, canManageGoals, canInstall, lastEventAt],
  );
  return <AnalyticsScopeContext value={scope}>{children}</AnalyticsScopeContext>;
}

/** The dashboard's Web analytics page (router.tsx). Use the timezone set in Settings. */
export function AnalyticsPage({
  projectId,
  range,
  filters,
  environment = DEFAULT_ENVIRONMENT,
  goalSearch = {},
}: {
  projectId: string;
  range: PageRange;
  filters: Filters;
  environment?: string;
  /** The goal filter in the address (docs/web-analytics.md, "The goal filter"), unchecked. */
  goalSearch?: { goal?: string | undefined; goalEvent?: string | undefined };
}) {
  return (
    <DashboardAnalyticsScope projectId={projectId}>
      <AnalyticsView
        range={range}
        filters={filters}
        environment={environment}
        goalSearch={goalSearch}
      />
    </DashboardAnalyticsScope>
  );
}
