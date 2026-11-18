import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  parseSearchWith,
  redirect,
  type RouterHistory,
  type SearchSchemaInput,
  stringifySearchWith,
} from "@tanstack/react-router";
import type * as React from "react";

import { AppLayout } from "@/app";
import { NoAccess } from "@/components/no-access";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AlertsPage } from "@/features/alerts/alerts-page";
import { AnalyticsPage } from "@/features/analytics/analytics-page";
import { SetupPage } from "@/features/auth/setup-page";
import { SignInPage } from "@/features/auth/sign-in-page";
import { DesignSystemPage } from "@/features/design-system/design-system-page";
import { ErrorPage } from "@/features/errors/error-page";
import { ErrorsPage } from "@/features/errors/errors-page";
import { EventPage } from "@/features/product/event-page";
import { EventsPage } from "@/features/product/events-page";
import { FunnelPage } from "@/features/product/funnel-page";
import { ProductLayout } from "@/features/product/product-layout";
import { RetentionPage } from "@/features/product/retention-page";
import {
  type FilterSearch,
  filterSearchOf,
  propertyFiltersFrom,
  savedFunnelIdFrom,
  stepsFrom,
} from "@/features/product/search";
import { ProjectLayout } from "@/features/projects/project-layout";
import { ProjectSettingsPage } from "@/features/projects/project-settings-page";
import { ProjectsPage } from "@/features/projects/projects-page";
import { ReplayPage } from "@/features/replays/replay-page";
import { ReplaysPage } from "@/features/replays/replays-page";
import { replayFiltersFrom } from "@/features/replays/search";
import { SettingsPage } from "@/features/settings/settings-page";
import { SpeedPage } from "@/features/speed/speed-page";
import { DatabasesPage } from "@/features/telemetry/databases-page";
import { HostPage } from "@/features/telemetry/host-page";
import { HostsPage } from "@/features/telemetry/hosts-page";
import { LogsPage } from "@/features/telemetry/logs-page";
import { MetricPage } from "@/features/telemetry/metric-page";
import { MetricsPage } from "@/features/telemetry/metrics-page";
import { QueryShapePage } from "@/features/telemetry/query-shape-page";
import {
  logFiltersFrom,
  metricChoicesFrom,
  metricFiltersFrom,
  isNamedRoute,
  searchValue,
  serviceChoiceFrom,
  traceFiltersFrom,
} from "@/features/telemetry/search";
import { ServicePage } from "@/features/telemetry/service-page";
import { ServicesPage } from "@/features/telemetry/services-page";
import { TracePage } from "@/features/telemetry/trace-page";
import { TracesPage } from "@/features/telemetry/traces-page";
import { CheckPage } from "@/features/uptime/check-page";
import { UptimePage } from "@/features/uptime/uptime-page";
import { UserPage } from "@/features/users/user-page";
import { UsersPage } from "@/features/users/users-page";
import { firstPage, meQuery, type PageAccess } from "@/lib/access";
import { isRuleKind, type RuleKind } from "@/lib/alerts-api";
import {
  DEFAULT_ENVIRONMENT,
  environmentFrom,
  type Filters,
  filtersFrom,
  isPeriod,
  type Period,
  rangeFrom,
} from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { DEFAULT_DATABASE_SORT, isDatabaseSort } from "@/lib/databases-api";
import { DEFAULT_STATUS_FILTER, isStatusFilter, type StatusFilter } from "@/lib/errors-api";
import { lastProject } from "@/lib/last-project";
import { isMetricKind, type MetricKind } from "@/lib/metrics-api";
import {
  DEFAULT_FUNNEL_WINDOW,
  type FunnelStep,
  type FunnelWindow,
  isFunnelWindow,
  windowAllowed,
} from "@/lib/product-api";
import { projectsQuery } from "@/lib/projects-api";
import { type Device, isDevice } from "@/lib/speed-api";

async function signedIn(): Promise<boolean> {
  const { data } = await authClient.getSession();
  return data !== null;
}

/**
 * Reads a query value as JSON only when writing that JSON back gives the
 * same text, so the router's JSON reading never changes a value: "2024"
 * and "true" still read as values, while "2024.10", "1e3", or a 20-digit
 * number stay text, exactly as a hand-written filter has them. Links the
 * app builds quote such values, so they read back the same either way.
 */
function parseExactJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  if (JSON.stringify(value) !== text) {
    throw new Error("Not JSON as JSON.stringify writes it");
  }
  return value;
}

const isClientError = (error: unknown) =>
  error instanceof ApiError && error.status >= 400 && error.status < 500;

/** What every route can read from the router. */
interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
});

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-in",
  beforeLoad: async () => {
    if (await signedIn()) {
      throw redirect({ to: "/" });
    }
  },
  component: SignInPage,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  component: SetupPage,
});

/** Every page inside needs a session; without one, the visitor goes to sign-in. */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  beforeLoad: async () => {
    if (!(await signedIn())) {
      throw redirect({ to: "/sign-in" });
    }
  },
  component: AppLayout,
});

/** Opens the project shown last in this browser, or the first one; with none, the project list. */
const homeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  beforeLoad: async ({ context }) => {
    const [projects, me] = await Promise.all([
      context.queryClient.ensureQueryData(projectsQuery()),
      context.queryClient.ensureQueryData(meQuery()),
    ]);
    const last = lastProject();
    // The list holds only the projects this user may reach.
    const project = projects.find((item) => item.id === last) ?? projects[0];
    const page = firstPage(me);
    if (project === undefined || page === null) {
      throw redirect({ to: "/projects" });
    }
    throw redirect({ to: page, params: { projectId: project.id } });
  },
});

/** The list of projects: the instance level, above any one project. */
const projectsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/projects",
  staticData: { title: "Projects" },
  component: ProjectsPage,
});

/**
 * Inside one project. Every module (web analytics, speed, users, errors,
 * product analytics) is a page under it, and the sidebar
 * switches to the project's own menu.
 */
const projectRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/projects/$projectId",
  component: function ProjectRouteComponent() {
    const { projectId } = projectRoute.useParams();
    return <ProjectLayout projectId={projectId} />;
  },
});

/**
 * A project opens on its web analytics until it has an overview page; a
 * member without web analytics, on the first area they have. With none,
 * the page says they have no access.
 */
const projectIndexRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/",
  beforeLoad: async ({ params, context }) => {
    const me = await context.queryClient.ensureQueryData(meQuery());
    const page = firstPage(me);
    if (page !== null) {
      throw redirect({ to: page, params });
    }
  },
  component: NoAccess,
});

const webAnalyticsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/web-analytics",
  staticData: { title: "Web analytics", access: "web_analytics" },
  // An unknown or missing period falls back to the default instead of failing.
  // The router merges the result over the raw query, so an invalid period
  // has to be overwritten, not just left out.
  // Filters (country=DE, page=/pricing …) live in the address too, so a
  // filtered view can be linked, reloaded, and left with the Back button.
  // Chosen days (from, to) win over a period; days the API would refuse are
  // dropped, so the page shows the default period instead of an error.
  // The environment (env) is left out for production, the default.
  validateSearch: (
    search: { period?: unknown; from?: unknown; to?: unknown; env?: unknown } & Partial<
      Record<keyof Filters, unknown>
    > &
      SearchSchemaInput,
  ): {
    period: Period | undefined;
    from: string | undefined;
    to: string | undefined;
    env: string | undefined;
  } & Filters => {
    const range = rangeFrom(search);
    const environment = environmentFrom(search.env);
    return {
      period: "period" in range && isPeriod(search.period) ? range.period : undefined,
      from: "from" in range ? range.from : undefined,
      to: "to" in range ? range.to : undefined,
      env: environment === DEFAULT_ENVIRONMENT ? undefined : environment,
      ...filtersFrom(search),
    };
  },
  component: function WebAnalyticsRouteComponent() {
    const { projectId } = webAnalyticsRoute.useParams();
    const { period, from, to, env, ...filters } = webAnalyticsRoute.useSearch();
    return (
      <AnalyticsPage
        projectId={projectId}
        range={rangeFrom({ period, from, to })}
        filters={filters}
        environment={env ?? DEFAULT_ENVIRONMENT}
      />
    );
  },
});

/** The environment from a page's address: left out for production, the default. */
const environmentSearch = (search: { env?: unknown }): { env: string | undefined } => {
  const environment = environmentFrom(search.env);
  return { env: environment === DEFAULT_ENVIRONMENT ? undefined : environment };
};

const usersRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/users",
  staticData: { title: "Users", access: "users" },
  validateSearch: (search: { env?: unknown } & SearchSchemaInput) => environmentSearch(search),
  component: function UsersRouteComponent() {
    const { projectId } = usersRoute.useParams();
    const { env } = usersRoute.useSearch();
    return <UsersPage projectId={projectId} environment={env ?? DEFAULT_ENVIRONMENT} key={env} />;
  },
});

const userRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/users/$userId",
  staticData: { title: "User", access: "users" },
  validateSearch: (search: { env?: unknown } & SearchSchemaInput) => environmentSearch(search),
  component: function UserRouteComponent() {
    const { projectId, userId } = userRoute.useParams();
    const { env } = userRoute.useSearch();
    return (
      <UserPage projectId={projectId} userId={userId} environment={env ?? DEFAULT_ENVIRONMENT} />
    );
  },
});

/** The days from a page's address: chosen days, or a period, left out for the default. */
const rangeSearch = (search: {
  period?: unknown;
  from?: unknown;
  to?: unknown;
}): { period: Period | undefined; from: string | undefined; to: string | undefined } => {
  const range = rangeFrom(search);
  return {
    period: "period" in range && isPeriod(search.period) ? range.period : undefined,
    from: "from" in range ? range.from : undefined,
    to: "to" in range ? range.to : undefined,
  };
};

type ErrorSearchInput = {
  period?: unknown;
  from?: unknown;
  to?: unknown;
  env?: unknown;
} & SearchSchemaInput;

/** The error groups: days and environment as on web analytics, and a status (left out for unresolved). */
const errorsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/errors",
  staticData: { title: "Errors", access: "errors" },
  validateSearch: (
    search: ErrorSearchInput & { status?: unknown },
  ): ReturnType<typeof rangeSearch> & { env: string | undefined } & {
    status: StatusFilter | undefined;
  } => ({
    ...rangeSearch(search),
    ...environmentSearch(search),
    status:
      isStatusFilter(search.status) && search.status !== DEFAULT_STATUS_FILTER
        ? search.status
        : undefined,
  }),
  component: function ErrorsRouteComponent() {
    const { projectId } = errorsRoute.useParams();
    const { period, from, to, env, status } = errorsRoute.useSearch();
    return (
      <ErrorsPage
        projectId={projectId}
        range={rangeFrom({ period, from, to })}
        environment={env ?? DEFAULT_ENVIRONMENT}
        status={status ?? DEFAULT_STATUS_FILTER}
      />
    );
  },
});

const errorRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/errors/$fingerprint",
  staticData: { title: "Error", access: "errors" },
  validateSearch: (search: ErrorSearchInput) => ({
    ...rangeSearch(search),
    ...environmentSearch(search),
  }),
  component: function ErrorRouteComponent() {
    const { projectId, fingerprint } = errorRoute.useParams();
    const { period, from, to, env } = errorRoute.useSearch();
    return (
      <ErrorPage
        projectId={projectId}
        fingerprint={fingerprint}
        range={rangeFrom({ period, from, to })}
        environment={env ?? DEFAULT_ENVIRONMENT}
      />
    );
  },
});

/**
 * The project's session replays: days and environment as on errors, and
 * filters (a path, a user, an error group, a minimum length), each left
 * out when unset.
 */
const replaysRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/replays",
  staticData: { title: "Replays", access: "replays" },
  validateSearch: (
    search: ErrorSearchInput & { path?: unknown; user?: unknown; error?: unknown; min?: unknown },
  ) => {
    const filters = replayFiltersFrom(search);
    return {
      ...rangeSearch(search),
      ...environmentSearch(search),
      path: filters.path,
      user: filters.userId,
      error: filters.fingerprint,
      min: filters.minDuration,
    };
  },
  component: function ReplaysRouteComponent() {
    const { projectId } = replaysRoute.useParams();
    const { period, from, to, env, path, user, error, min } = replaysRoute.useSearch();
    return (
      <ReplaysPage
        projectId={projectId}
        range={rangeFrom({ period, from, to })}
        environment={env ?? DEFAULT_ENVIRONMENT}
        filters={{ path, userId: user, fingerprint: error, minDuration: min }}
      />
    );
  },
});

const replayRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/replays/$replayId",
  staticData: { title: "Replay", access: "replays" },
  component: function ReplayRouteComponent() {
    const { projectId, replayId } = replayRoute.useParams();
    return <ReplayPage projectId={projectId} replayId={replayId} key={replayId} />;
  },
});

/** Web Vitals: days and environment as on errors, and a kind of device (left out for all). */
const speedRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/speed",
  staticData: { title: "Speed", access: "web_analytics" },
  validateSearch: (
    search: ErrorSearchInput & { device?: unknown },
  ): ReturnType<typeof rangeSearch> & { env: string | undefined } & {
    device: Device | undefined;
  } => ({
    ...rangeSearch(search),
    ...environmentSearch(search),
    device: isDevice(search.device) ? search.device : undefined,
  }),
  component: function SpeedRouteComponent() {
    const { projectId } = speedRoute.useParams();
    const { period, from, to, env, device } = speedRoute.useSearch();
    return (
      <SpeedPage
        projectId={projectId}
        range={rangeFrom({ period, from, to })}
        environment={env ?? DEFAULT_ENVIRONMENT}
        device={device}
      />
    );
  },
});

/**
 * A server's traces: days and environment as on errors, and filters
 * (service, name, errors, a minimum duration), each left out when unset.
 */
const tracesRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/traces",
  staticData: { title: "Traces", access: "monitoring" },
  validateSearch: (
    search: ErrorSearchInput & {
      service?: unknown;
      name?: unknown;
      errors?: unknown;
      min?: unknown;
    },
  ) => {
    const filters = traceFiltersFrom(search);
    return {
      ...rangeSearch(search),
      ...environmentSearch(search),
      service: filters.service,
      name: filters.name,
      errors: filters.errors,
      min: filters.minDuration,
    };
  },
  component: function TracesRouteComponent() {
    const { projectId } = tracesRoute.useParams();
    const { period, from, to, env, service, name, errors, min } = tracesRoute.useSearch();
    return (
      <TracesPage
        projectId={projectId}
        range={rangeFrom({ period, from, to })}
        environment={env ?? DEFAULT_ENVIRONMENT}
        filters={{ service, name, errors, minDuration: min }}
      />
    );
  },
});

/** An ISO time in UTC, as the API takes it: when the trace is known to have run. */
const isMoment = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/.test(value) &&
  !Number.isNaN(Date.parse(value));

/**
 * One trace. `at` (when it ran, from an error or a list) narrows where it
 * is looked for; `span` is the span shown, so a link can open on it.
 */
const traceRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/traces/$traceId",
  staticData: { title: "Trace", access: "monitoring" },
  validateSearch: (
    search: { at?: unknown; span?: unknown } & SearchSchemaInput,
  ): { at: string | undefined; span: string | undefined } => ({
    at: isMoment(search.at) ? search.at : undefined,
    span:
      typeof search.span === "string" && /^[0-9a-f]{16}$/.test(search.span)
        ? search.span
        : undefined,
  }),
  component: function TraceRouteComponent() {
    const { projectId, traceId } = traceRoute.useParams();
    const { at, span } = traceRoute.useSearch();
    return <TracePage projectId={projectId} traceId={traceId} at={at} spanId={span} />;
  },
});

/** A server's log records: days and environment, and filters (service, severity, words, trace). */
const logsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/logs",
  staticData: { title: "Logs", access: "monitoring" },
  validateSearch: (
    search: ErrorSearchInput & {
      service?: unknown;
      severity?: unknown;
      q?: unknown;
      trace?: unknown;
    },
  ) => {
    const filters = logFiltersFrom(search);
    return {
      ...rangeSearch(search),
      ...environmentSearch(search),
      service: filters.service,
      severity: filters.severity,
      q: filters.search,
      trace: filters.traceId,
    };
  },
  component: function LogsRouteComponent() {
    const { projectId } = logsRoute.useParams();
    const { period, from, to, env, service, severity, q, trace } = logsRoute.useSearch();
    return (
      <LogsPage
        projectId={projectId}
        range={rangeFrom({ period, from, to })}
        environment={env ?? DEFAULT_ENVIRONMENT}
        filters={{ service, severity, search: q, traceId: trace }}
      />
    );
  },
});

/** A server's metrics: days and environment, as on the other telemetry pages. */
const metricsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/metrics",
  staticData: { title: "Metrics", access: "monitoring" },
  validateSearch: (search: ErrorSearchInput) => ({
    ...rangeSearch(search),
    ...environmentSearch(search),
  }),
  component: function MetricsRouteComponent() {
    const { projectId } = metricsRoute.useParams();
    const { period, from, to, env } = metricsRoute.useSearch();
    return (
      <MetricsPage
        projectId={projectId}
        range={rangeFrom({ period, from, to })}
        environment={env ?? DEFAULT_ENVIRONMENT}
      />
    );
  },
});

/**
 * One metric: its name in the path, its kind (a name may be sent as two
 * kinds), and the attribute it is split by and the measure shown, each
 * left out when unset.
 */
const metricRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/metrics/$name",
  staticData: { title: "Metric", access: "monitoring" },
  validateSearch: (
    search: ErrorSearchInput & {
      kind?: unknown;
      split?: unknown;
      stat?: unknown;
      host?: unknown;
      attr?: unknown;
      attrValue?: unknown;
    },
  ) => {
    const { host, attr } = metricFiltersFrom(search);
    return {
      ...rangeSearch(search),
      ...environmentSearch(search),
      ...metricChoicesFrom(search),
      host,
      attr: attr?.key,
      attrValue: attr?.value,
    };
  },
  component: function MetricRouteComponent() {
    const { projectId, name } = metricRoute.useParams();
    const { period, from, to, env, kind, split, stat, host, attr, attrValue } =
      metricRoute.useSearch();
    return (
      <MetricPage
        projectId={projectId}
        name={name}
        kind={kind}
        range={rangeFrom({ period, from, to })}
        environment={env ?? DEFAULT_ENVIRONMENT}
        split={split}
        stat={stat}
        host={host}
        attr={
          attr === undefined || attrValue === undefined
            ? undefined
            : { key: attr, value: attrValue }
        }
      />
    );
  },
});

/** Each service's requests by route: days and environment; optionally one service, a route of it marked. */
const servicesRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/services",
  staticData: { title: "Services", access: "monitoring" },
  validateSearch: (search: ErrorSearchInput & { service?: unknown; route?: unknown }) => ({
    ...rangeSearch(search),
    ...environmentSearch(search),
    ...serviceChoiceFrom(search),
  }),
  component: function ServicesRouteComponent() {
    const { projectId } = servicesRoute.useParams();
    const { period, from, to, env, service, route } = servicesRoute.useSearch();
    return (
      <ServicesPage
        projectId={projectId}
        range={rangeFrom({ period, from, to })}
        environment={env ?? DEFAULT_ENVIRONMENT}
        service={service}
        route={route}
      />
    );
  },
});

/** One service's charts: its name in the path; days, environment, and optionally one of its routes. */
const serviceRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/services/$service",
  staticData: { title: "Service", access: "monitoring" },
  validateSearch: (search: ErrorSearchInput & { route?: unknown }) => {
    const route = searchValue(search.route);
    return {
      ...rangeSearch(search),
      ...environmentSearch(search),
      // A route of only spaces has no page: the service's shows instead.
      route: route !== undefined && isNamedRoute(route) ? route : undefined,
    };
  },
  component: function ServiceRouteComponent() {
    const { projectId, service } = serviceRoute.useParams();
    const { period, from, to, env, route } = serviceRoute.useSearch();
    return (
      <ServicePage
        projectId={projectId}
        service={service}
        route={route}
        range={rangeFrom({ period, from, to })}
        environment={env ?? DEFAULT_ENVIRONMENT}
      />
    );
  },
});

/** The database calls in traces: days, environment, and what the query shapes are sorted by. */
const databasesRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/databases",
  staticData: { title: "Databases", access: "monitoring" },
  validateSearch: (search: ErrorSearchInput & { sort?: unknown }) => ({
    ...rangeSearch(search),
    ...environmentSearch(search),
    sort:
      isDatabaseSort(search.sort) && search.sort !== DEFAULT_DATABASE_SORT
        ? search.sort
        : undefined,
  }),
  component: function DatabasesRouteComponent() {
    const { projectId } = databasesRoute.useParams();
    const { period, from, to, env, sort } = databasesRoute.useSearch();
    return (
      <DatabasesPage
        projectId={projectId}
        range={rangeFrom({ period, from, to })}
        environment={env ?? DEFAULT_ENVIRONMENT}
        sort={sort ?? DEFAULT_DATABASE_SORT}
      />
    );
  },
});

/** One query shape: its ID in the path; days and environment. */
const queryShapeRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/databases/$shapeId",
  staticData: { title: "Query shape", access: "monitoring" },
  validateSearch: (search: ErrorSearchInput) => ({
    ...rangeSearch(search),
    ...environmentSearch(search),
  }),
  component: function QueryShapeRouteComponent() {
    const { projectId, shapeId } = queryShapeRoute.useParams();
    const { period, from, to, env } = queryShapeRoute.useSearch();
    return (
      <QueryShapePage
        projectId={projectId}
        shapeId={shapeId}
        range={rangeFrom({ period, from, to })}
        environment={env ?? DEFAULT_ENVIRONMENT}
      />
    );
  },
});

/** The hosts that sent host metrics: days and environment. */
const hostsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/hosts",
  staticData: { title: "Hosts", access: "monitoring" },
  validateSearch: (search: ErrorSearchInput) => ({
    ...rangeSearch(search),
    ...environmentSearch(search),
  }),
  component: function HostsRouteComponent() {
    const { projectId } = hostsRoute.useParams();
    const { period, from, to, env } = hostsRoute.useSearch();
    return (
      <HostsPage
        projectId={projectId}
        range={rangeFrom({ period, from, to })}
        environment={env ?? DEFAULT_ENVIRONMENT}
      />
    );
  },
});

/** One host's charts: its host.name in the path. */
const hostRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/hosts/$host",
  staticData: { title: "Host", access: "monitoring" },
  validateSearch: (search: ErrorSearchInput) => ({
    ...rangeSearch(search),
    ...environmentSearch(search),
  }),
  component: function HostRouteComponent() {
    const { projectId, host } = hostRoute.useParams();
    const { period, from, to, env } = hostRoute.useSearch();
    return (
      <HostPage
        projectId={projectId}
        host={host}
        range={rangeFrom({ period, from, to })}
        environment={env ?? DEFAULT_ENVIRONMENT}
      />
    );
  },
});

/** The project's uptime checks. */
const uptimeRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/uptime",
  staticData: { title: "Uptime", access: "uptime_alerts" },
  component: function UptimeRouteComponent() {
    const { projectId } = uptimeRoute.useParams();
    return <UptimePage projectId={projectId} />;
  },
});

/** One check: its ID in the path, and the days its chart, failures, and incidents cover. */
const checkRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/uptime/$checkId",
  staticData: { title: "Check", access: "uptime_alerts" },
  validateSearch: (
    search: { period?: unknown; from?: unknown; to?: unknown } & SearchSchemaInput,
  ) => rangeSearch(search),
  component: function CheckRouteComponent() {
    const { projectId, checkId } = checkRoute.useParams();
    const { period, from, to } = checkRoute.useSearch();
    return (
      <CheckPage projectId={projectId} checkId={checkId} range={rangeFrom({ period, from, to })} />
    );
  },
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINGERPRINT = /^[0-9]{1,3}-[0-9a-f]{20}$/;

/**
 * The project's alert rules. `add` opens the form for a new rule of that
 * kind, with what the page it came from knows: its check, its error group
 * and environment, a service and route (the Services page), or a metric
 * with its kind and filters (a metric's page).
 */
const alertsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/alerts",
  staticData: { title: "Alerts", access: "uptime_alerts" },
  validateSearch: (
    search: {
      add?: unknown;
      check?: unknown;
      fingerprint?: unknown;
      env?: unknown;
      service?: unknown;
      route?: unknown;
      metric?: unknown;
      metricKind?: unknown;
      host?: unknown;
      attr?: unknown;
      attrValue?: unknown;
    } & SearchSchemaInput,
  ): {
    add: RuleKind | undefined;
    check: string | undefined;
    fingerprint: string | undefined;
    env: string | undefined;
    service: string | undefined;
    route: string | undefined;
    metric: string | undefined;
    metricKind: MetricKind | undefined;
    host: string | undefined;
    attr: string | undefined;
    attrValue: string | undefined;
  } => ({
    add: isRuleKind(search.add) ? search.add : undefined,
    check: typeof search.check === "string" && UUID.test(search.check) ? search.check : undefined,
    fingerprint:
      typeof search.fingerprint === "string" && FINGERPRINT.test(search.fingerprint)
        ? search.fingerprint
        : undefined,
    env:
      search.env === undefined
        ? undefined
        : environmentFrom(typeof search.env === "number" ? String(search.env) : search.env),
    ...serviceChoiceFrom(search),
    metric: searchValue(search.metric, 1024),
    metricKind: isMetricKind(search.metricKind) ? search.metricKind : undefined,
    ...(() => {
      const { host, attr } = metricFiltersFrom(search);
      return { host, attr: attr?.key, attrValue: attr?.value };
    })(),
  }),
  component: function AlertsRouteComponent() {
    const { projectId } = alertsRoute.useParams();
    const search = alertsRoute.useSearch();
    return <AlertsPage projectId={projectId} prefill={search} />;
  },
});

/** Product analytics: its reports (events, funnel, retention) as tabs, each its own page. */
const productRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/product",
  staticData: { title: "Product analytics", access: "product_analytics" },
  component: function ProductRouteComponent() {
    const { projectId } = productRoute.useParams();
    return <ProductLayout projectId={projectId} />;
  },
});

const productRangeSearch = (search: ErrorSearchInput) => ({
  ...rangeSearch(search),
  ...environmentSearch(search),
});

/** Product analytics opens on its events, keeping the days and environment. */
const productIndexRoute = createRoute({
  getParentRoute: () => productRoute,
  path: "/",
  validateSearch: productRangeSearch,
  beforeLoad: ({ params, search }) => {
    throw redirect({ to: "/projects/$projectId/product/events", params, search });
  },
});

const productEventsRoute = createRoute({
  getParentRoute: () => productRoute,
  path: "/events",
  validateSearch: productRangeSearch,
  component: function ProductEventsRouteComponent() {
    const { projectId } = productEventsRoute.useParams();
    const { period, from, to, env } = productEventsRoute.useSearch();
    return (
      <EventsPage
        projectId={projectId}
        range={rangeFrom({ period, from, to })}
        environment={env ?? DEFAULT_ENVIRONMENT}
      />
    );
  },
});

/**
 * One product event. Its property filters live in the address as the API
 * takes them ("p.plan=team"), so a filtered view can be linked and reloaded.
 */
const productEventRoute = createRoute({
  getParentRoute: () => productRoute,
  path: "/events/$name",
  validateSearch: (
    search: ErrorSearchInput & Record<string, unknown>,
  ): ReturnType<typeof productRangeSearch> & FilterSearch => ({
    ...productRangeSearch(search),
    ...filterSearchOf(propertyFiltersFrom(search)),
  }),
  component: function ProductEventRouteComponent() {
    const { projectId, name } = productEventRoute.useParams();
    const { period, from, to, env, ...rest } = productEventRoute.useSearch();
    return (
      <EventPage
        projectId={projectId}
        name={name}
        range={rangeFrom({ period, from, to })}
        environment={env ?? DEFAULT_ENVIRONMENT}
        filters={propertyFiltersFrom(rest)}
      />
    );
  },
});

/**
 * The funnel: its steps as the JSON the API takes, who it counts (left out
 * for visitors), and its window in seconds (left out for a day). A window
 * visitors cannot have falls back to a day. `funnel` is the saved funnel
 * last opened or saved, by ID; the steps stay in the address all the same,
 * so a link shows what was viewed.
 */
const productFunnelRoute = createRoute({
  getParentRoute: () => productRoute,
  path: "/funnel",
  validateSearch: (
    search: ErrorSearchInput & {
      funnel?: unknown;
      steps?: unknown;
      count?: unknown;
      window?: unknown;
    },
  ): ReturnType<typeof productRangeSearch> & {
    funnel: string | undefined;
    steps: FunnelStep[] | undefined;
    count: "users" | undefined;
    window: FunnelWindow | undefined;
  } => {
    const steps = stepsFrom(search.steps);
    const count = search.count === "users" ? "users" : undefined;
    const window =
      isFunnelWindow(search.window) &&
      search.window !== DEFAULT_FUNNEL_WINDOW &&
      windowAllowed(count ?? "visitors", search.window)
        ? search.window
        : undefined;
    return {
      ...productRangeSearch(search),
      funnel: savedFunnelIdFrom(search.funnel),
      steps: steps.length === 0 ? undefined : steps,
      count,
      window,
    };
  },
  component: function ProductFunnelRouteComponent() {
    const { projectId } = productFunnelRoute.useParams();
    const { period, from, to, env, funnel, steps, count, window } = productFunnelRoute.useSearch();
    return (
      <FunnelPage
        projectId={projectId}
        range={rangeFrom({ period, from, to })}
        environment={env ?? DEFAULT_ENVIRONMENT}
        funnel={funnel}
        steps={steps ?? []}
        count={count ?? "visitors"}
        window={window ?? DEFAULT_FUNNEL_WINDOW}
      />
    );
  },
});

const productRetentionRoute = createRoute({
  getParentRoute: () => productRoute,
  path: "/retention",
  validateSearch: productRangeSearch,
  component: function ProductRetentionRouteComponent() {
    const { projectId } = productRetentionRoute.useParams();
    const { period, from, to, env } = productRetentionRoute.useSearch();
    return (
      <RetentionPage
        projectId={projectId}
        range={rangeFrom({ period, from, to })}
        environment={env ?? DEFAULT_ENVIRONMENT}
      />
    );
  },
});

const projectSettingsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/settings",
  staticData: { title: "Settings", access: "project_settings" },
  component: function ProjectSettingsRouteComponent() {
    const { projectId } = projectSettingsRoute.useParams();
    return <ProjectSettingsPage projectId={projectId} />;
  },
});

/** The instance's settings: the workspace level, above any one project. */
const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  staticData: { title: "Settings" },
  component: SettingsPage,
});

const designSystemRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/design-system",
  staticData: { title: "Design system" },
  component: DesignSystemPage,
});

const routeTree = rootRoute.addChildren([
  signInRoute,
  setupRoute,
  appRoute.addChildren([
    homeRoute,
    projectsRoute,
    projectRoute.addChildren([
      projectIndexRoute,
      webAnalyticsRoute,
      speedRoute,
      usersRoute,
      userRoute,
      errorsRoute,
      errorRoute,
      replaysRoute,
      replayRoute,
      tracesRoute,
      traceRoute,
      logsRoute,
      metricsRoute,
      metricRoute,
      servicesRoute,
      serviceRoute,
      databasesRoute,
      queryShapeRoute,
      hostsRoute,
      hostRoute,
      uptimeRoute,
      checkRoute,
      alertsRoute,
      productRoute.addChildren([
        productIndexRoute,
        productEventsRoute,
        productEventRoute,
        productFunnelRoute,
        productRetentionRoute,
      ]),
      projectSettingsRoute,
    ]),
    settingsRoute,
    designSystemRoute,
  ]),
]);

/**
 * The dashboard's router, with its own query cache. The app makes one at
 * start-up; tests make one per test, with an in-memory history, so no state
 * carries over between them.
 */
export function createAppRouter({
  history,
  retryDelayMs,
}: {
  history?: RouterHistory;
  /** Wait before retrying a failed request; React Query's backoff when left out. Tests set 0. */
  retryDelayMs?: number;
} = {}) {
  const queryClient = new QueryClient({
    queryCache: new QueryCache({
      // A session that ended (signed out elsewhere, or expired) sends the
      // visitor to sign-in instead of showing errors.
      onError: (error) => {
        if (error instanceof ApiError && error.status === 401) {
          // As on signing out: whoever signs in next starts with nothing cached.
          queryClient.clear();
          void router.navigate({ to: "/sign-in" });
        }
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        // A 4xx answer (not found, forbidden) will not change on a retry.
        retry: (failures, error) => !isClientError(error) && failures < 2,
        ...(retryDelayMs === undefined ? {} : { retryDelay: retryDelayMs }),
      },
    },
  });
  const router = createRouter({
    routeTree,
    ...(history === undefined ? {} : { history }),
    context: { queryClient },
    parseSearch: parseSearchWith(parseExactJson),
    stringifySearch: stringifySearchWith(JSON.stringify, parseExactJson),
    Wrap: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>{children}</TooltipProvider>
      </QueryClientProvider>
    ),
  });
  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
  interface StaticDataRouteOption {
    /** Shown in the header of signed-in pages. */
    title?: string;
    /** What a project page needs (docs/access.md); without it, the page says so. */
    access?: PageAccess;
  }
}
