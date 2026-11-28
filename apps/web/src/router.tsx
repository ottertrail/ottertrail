import { CSPProvider } from "@base-ui/react/csp-provider";
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  notFound,
  Outlet,
  parseSearchWith,
  redirect,
  rootRouteId,
  type RouterHistory,
  type SearchSchemaInput,
  stringifySearchWith,
} from "@tanstack/react-router";
import type * as React from "react";

import { AppLayout } from "@/app";
import { NoAccess } from "@/components/no-access";
import { AuthPending, PagePending, RouteError, RouteNotFound } from "@/components/route-states";
import { TooltipProvider } from "@/components/ui/tooltip";
import { aiCallFiltersFrom, aiCallsViewFrom, isCallId } from "@/features/ai/calls-search";
import { type DeviceChoice, isDeviceChoice, pathFrom } from "@/features/heatmaps/search";
import { ProductLayout } from "@/features/product/product-layout";
import {
  type FilterSearch,
  filterSearchOf,
  propertyFiltersFrom,
  savedFunnelIdFrom,
  startEventFrom,
  stepsFrom,
} from "@/features/product/search";
import { ProjectLayout } from "@/features/projects/project-layout";
import { replayFiltersFrom } from "@/features/replays/search";
import {
  aiFiltersFrom,
  logFiltersFrom,
  metricChoicesFrom,
  metricFiltersFrom,
  isNamedRoute,
  searchValue,
  serviceChoiceFrom,
  traceFiltersFrom,
} from "@/features/telemetry/search";
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
import { sessionQuery } from "@/lib/auth-client";
import { DEFAULT_DATABASE_SORT, isDatabaseSort } from "@/lib/databases-api";
import {
  type AssigneeFilter,
  DEFAULT_ASSIGNEE_FILTER,
  DEFAULT_STATUS_FILTER,
  isAssigneeFilter,
  isStatusFilter,
  type StatusFilter,
} from "@/lib/errors-api";
import { lastProject } from "@/lib/last-project";
import { lazyPage, withPage } from "@/lib/lazy-page";
import { isTraceId, logWindowFrom } from "@/lib/logs-api";
import { isMetricKind, type MetricKind } from "@/lib/metrics-api";
import { markNavigated } from "@/lib/navigations";
import { DEFAULT_OVERVIEW_PERIOD, isOverviewPeriod, type OverviewPeriod } from "@/lib/overview-api";
import {
  DEFAULT_FUNNEL_WINDOW,
  type FunnelBreakdownBy,
  type FunnelStep,
  type FunnelWindow,
  isBreakdownBy,
  isFunnelWindow,
  windowAllowed,
} from "@/lib/product-api";
import { projectsQuery } from "@/lib/projects-api";
import { type Device, isDevice } from "@/lib/speed-api";

/**
 * Pages load on demand. Keep the shell, router, session check, and layouts
 * in the main chunk (docs/dashboard.md, "Code splitting").
 */
const AccountPage = lazyPage(() => import("@/features/account/account-page"), "AccountPage");
const AlertsPage = lazyPage(() => import("@/features/alerts/alerts-page"), "AlertsPage");
const AnalyticsPage = lazyPage(
  () => import("@/features/analytics/dashboard-analytics-page"),
  "AnalyticsPage",
);
const NotificationsPage = lazyPage(
  () => import("@/features/notifications/notifications-page"),
  "NotificationsPage",
);
const CheckPage = lazyPage(() => import("@/features/uptime/check-page"), "CheckPage");
const DatabasesPage = lazyPage(
  () => import("@/features/telemetry/databases-page"),
  "DatabasesPage",
);
const AiPage = lazyPage(() => import("@/features/ai/ai-page"), "AiPage");
const AiCallsPage = lazyPage(() => import("@/features/ai/calls-page"), "AiCallsPage");
const AiCallPage = lazyPage(() => import("@/features/ai/call-view"), "CallPage");
const AiConversationPage = lazyPage(() => import("@/features/ai/call-view"), "ConversationPage");
const ErrorPage = lazyPage(() => import("@/features/errors/error-page"), "ErrorPage");
const ErrorsPage = lazyPage(() => import("@/features/errors/errors-page"), "ErrorsPage");
const EventPage = lazyPage(() => import("@/features/product/event-page"), "EventPage");
const EventsPage = lazyPage(() => import("@/features/product/events-page"), "EventsPage");
const ForgotPasswordPage = lazyPage(
  () => import("@/features/auth/forgot-password-page"),
  "ForgotPasswordPage",
);
const FunnelPage = lazyPage(() => import("@/features/product/funnel-page"), "FunnelPage");
const HeatmapsPage = lazyPage(() => import("@/features/heatmaps/heatmaps-page"), "HeatmapsPage");
const HostPage = lazyPage(() => import("@/features/telemetry/host-page"), "HostPage");
const HostsPage = lazyPage(() => import("@/features/telemetry/hosts-page"), "HostsPage");
const InvitePage = lazyPage(() => import("@/features/auth/invite-page"), "InvitePage");
const LogsPage = lazyPage(() => import("@/features/telemetry/logs-page"), "LogsPage");
const MembersPage = lazyPage(() => import("@/features/settings/members-page"), "MembersPage");
const MetricPage = lazyPage(() => import("@/features/telemetry/metric-page"), "MetricPage");
const MetricsPage = lazyPage(() => import("@/features/telemetry/metrics-page"), "MetricsPage");
const OverviewPage = lazyPage(() => import("@/features/overview/overview-page"), "OverviewPage");
const RightNowPage = lazyPage(() => import("@/features/analytics/now-page"), "RightNowPage");
const ProjectSettingsPage = lazyPage(
  () => import("@/features/projects/project-settings-page"),
  "ProjectSettingsPage",
);
const ProjectsPage = lazyPage(() => import("@/features/projects/projects-page"), "ProjectsPage");
const QueryShapePage = lazyPage(
  () => import("@/features/telemetry/query-shape-page"),
  "QueryShapePage",
);
const ReplayPage = lazyPage(() => import("@/features/replays/replay-page"), "ReplayPage");
const ReplaysPage = lazyPage(() => import("@/features/replays/replays-page"), "ReplaysPage");
const ResetPasswordPage = lazyPage(
  () => import("@/features/auth/reset-password-page"),
  "ResetPasswordPage",
);
const RetentionPage = lazyPage(() => import("@/features/product/retention-page"), "RetentionPage");
const ActiveUsersPage = lazyPage(
  () => import("@/features/product/active-users-page"),
  "ActiveUsersPage",
);
const RulePage = lazyPage(() => import("@/features/alerts/rule-view"), "RulePage");
const ServicePage = lazyPage(() => import("@/features/telemetry/service-page"), "ServicePage");
const ServicesPage = lazyPage(() => import("@/features/telemetry/services-page"), "ServicesPage");
const SettingsPage = lazyPage(() => import("@/features/settings/settings-page"), "SettingsPage");
const SetupPage = lazyPage(() => import("@/features/auth/setup-page"), "SetupPage");
const SignInPage = lazyPage(() => import("@/features/auth/sign-in-page"), "SignInPage");
const SpeedPage = lazyPage(() => import("@/features/speed/speed-page"), "SpeedPage");
const TracePage = lazyPage(() => import("@/features/telemetry/trace-page"), "TracePage");
const TracesPage = lazyPage(() => import("@/features/telemetry/traces-page"), "TracesPage");
const UptimePage = lazyPage(() => import("@/features/uptime/uptime-page"), "UptimePage");
const UserPage = lazyPage(() => import("@/features/users/user-page"), "UserPage");
const UsersPage = lazyPage(() => import("@/features/users/users-page"), "UsersPage");

/** Reuses recent session checks from the query cache. */
const signedIn = (queryClient: QueryClient) => queryClient.fetchQuery(sessionQuery());

/**
 * Require an exact JSON round trip to preserve hand-written filters.
 * "2024" and "true" parse; "2024.10", "1e3", and inexact 20-digit numbers stay text.
 * App links quote these values to preserve them.
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

interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  // Signed-out visitors see unknown URLs without the shell.
  notFoundComponent: RouteNotFound,
});

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-in",
  // Failed session checks must not block the sign-in form.
  beforeLoad: async ({ context }) => {
    if (await signedIn(context.queryClient).catch(() => false)) {
      throw redirect({ to: "/" });
    }
  },
  component: SignInPage,
  pendingComponent: AuthPending,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  component: SetupPage,
  pendingComponent: AuthPending,
});

/** Public; the token stays in the fragment (docs/access.md). */
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invite",
  component: InvitePage,
  pendingComponent: AuthPending,
});

/** Public when email is configured. */
const forgotPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/forgot-password",
  component: ForgotPasswordPage,
  pendingComponent: AuthPending,
});

/** Public; the reset token stays in the fragment. */
const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reset-password",
  component: ResetPasswordPage,
  pendingComponent: AuthPending,
});

/**
 * Missing sessions and 401s redirect to sign-in. Other failures (429, 5xx,
 * no response) show RouteError before the shell and preserve the session.
 * Unknown URLs show a 404 inside the shell only for signed-in visitors.
 */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  beforeLoad: async ({ context, preload, matches }) => {
    // Skip preload session checks to stay under Better Auth's rate limit (100 requests per 10 s
    // for each address and path, get-session included; it has no rule of its own).
    // Navigation checks the session.
    if (preload) {
      return;
    }
    if (!(await signedIn(context.queryClient))) {
      const unknown = new Set<string>([unknownAddressRoute.id, unknownProjectPageRoute.id]);
      if (matches.some((match) => unknown.has(match.routeId))) {
        throw notFound({ routeId: rootRouteId });
      }
      throw redirect({ to: "/sign-in" });
    }
  },
  // Wait for the session check before showing the shell.
  pendingComponent: () => null,
  component: AppLayout,
});

const unknownAddressRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "$",
  component: RouteNotFound,
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

const projectsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/projects",
  staticData: { title: "Projects" },
  component: ProjectsPage,
});

const projectRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/projects/$projectId",
  // Discard forms, edits, and local state when switching projects.
  remountDeps: ({ params }) => params.projectId,
  component: function ProjectRouteComponent() {
    const { projectId } = projectRoute.useParams();
    return <ProjectLayout projectId={projectId} />;
  },
});

const unknownProjectPageRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "$",
  component: RouteNotFound,
});

/**
 * A project opens on its overview when the user has one of the overview's
 * areas; otherwise on the first area they have. With none, the page says
 * they have no access.
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

/**
 * The project's overview: its widgets, for the period in the address
 * (left out for the last 7 days) and the environment (left out for
 * production). Every user of the project may open it; a user with none of
 * its areas finds it empty, with the pages they can open.
 */
const overviewRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/overview",
  staticData: { title: "Overview" },
  validateSearch: (
    search: { period?: unknown; env?: unknown } & SearchSchemaInput,
  ): { period: OverviewPeriod | undefined; env: string | undefined } => ({
    period:
      isOverviewPeriod(search.period) && search.period !== DEFAULT_OVERVIEW_PERIOD
        ? search.period
        : undefined,
    ...environmentSearch(search),
  }),
  component: withPage(OverviewPage, function OverviewRouteComponent() {
    const { projectId } = overviewRoute.useParams();
    const { period, env } = overviewRoute.useSearch();
    return (
      <OverviewPage
        projectId={projectId}
        period={period ?? DEFAULT_OVERVIEW_PERIOD}
        environment={env ?? DEFAULT_ENVIRONMENT}
      />
    );
  }),
});

const webAnalyticsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/web-analytics",
  staticData: { title: "Web analytics", access: "web_analytics" },
  // The router merges over the raw query: overwrite invalid values explicitly.
  // URL filters support links, reloads, and Back navigation. Valid from/to days
  // override the period; invalid days fall back to the default period.
  // Omit the default production environment.
  validateSearch: (
    search: {
      period?: unknown;
      from?: unknown;
      to?: unknown;
      env?: unknown;
      goal?: unknown;
      goalEvent?: unknown;
    } & Partial<Record<keyof Filters, unknown>> &
      SearchSchemaInput,
  ): {
    period: Period | undefined;
    from: string | undefined;
    to: string | undefined;
    env: string | undefined;
    // The goal filter; the page checks it (goalChoiceFrom).
    goal: string | undefined;
    goalEvent: string | undefined;
  } & Filters => {
    const range = rangeFrom(search);
    const environment = environmentFrom(search.env);
    return {
      period: "period" in range && isPeriod(search.period) ? range.period : undefined,
      from: "from" in range ? range.from : undefined,
      to: "to" in range ? range.to : undefined,
      env: environment === DEFAULT_ENVIRONMENT ? undefined : environment,
      goal: selectionFrom(search.goal),
      goalEvent: selectionFrom(search.goalEvent),
      ...filtersFrom(search),
    };
  },
  component: withPage(AnalyticsPage, function WebAnalyticsRouteComponent() {
    const { projectId } = webAnalyticsRoute.useParams();
    const { period, from, to, env, goal, goalEvent, ...filters } = webAnalyticsRoute.useSearch();
    return (
      <AnalyticsPage
        projectId={projectId}
        range={rangeFrom({ period, from, to })}
        filters={filters}
        environment={env ?? DEFAULT_ENVIRONMENT}
        goalSearch={{ goal, goalEvent }}
      />
    );
  }),
});

/**
 * Right now: the visitors on the site in the last minutes, for the
 * environment in the address (left out for production). Its own address,
 * since the Web analytics page's period and filters do not apply to it.
 */
const rightNowRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/web-analytics/now",
  staticData: { title: "Right now", access: "web_analytics" },
  validateSearch: (search: { env?: unknown } & SearchSchemaInput) => environmentSearch(search),
  component: withPage(RightNowPage, function RightNowRouteComponent() {
    const { projectId } = rightNowRoute.useParams();
    const { env } = rightNowRoute.useSearch();
    return <RightNowPage projectId={projectId} environment={env ?? DEFAULT_ENVIRONMENT} />;
  }),
});

/** A workbench's selected item from an address: any short text, none when absent or empty. */
const selectionFrom = (value: unknown): string | undefined => {
  const text = typeof value === "number" ? String(value) : value;
  return typeof text === "string" && text !== "" && text.length <= 200 ? text : undefined;
};

/** The environment from a page's address: left out for production, the default. */
const environmentSearch = (search: { env?: unknown }): { env: string | undefined } => {
  const environment = environmentFrom(search.env);
  return { env: environment === DEFAULT_ENVIRONMENT ? undefined : environment };
};

const usersRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/users",
  staticData: { title: "Users", access: "users" },
  validateSearch: (search: { env?: unknown; user?: unknown } & SearchSchemaInput) => ({
    ...environmentSearch(search),
    // The workbench's selected user (docs/design-system.md, "Workbench").
    user: selectionFrom(search.user),
  }),
  component: withPage(UsersPage, function UsersRouteComponent() {
    const { projectId } = usersRoute.useParams();
    const { env } = usersRoute.useSearch();
    return <UsersPage projectId={projectId} environment={env ?? DEFAULT_ENVIRONMENT} key={env} />;
  }),
});

const userRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/users/$userId",
  staticData: { title: "User", access: "users" },
  validateSearch: (search: { env?: unknown } & SearchSchemaInput) => environmentSearch(search),
  component: withPage(UserPage, function UserRouteComponent() {
    const { projectId, userId } = userRoute.useParams();
    const { env } = userRoute.useSearch();
    return (
      <UserPage projectId={projectId} userId={userId} environment={env ?? DEFAULT_ENVIRONMENT} />
    );
  }),
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

/**
 * The error groups: days and environment as on web analytics, a status
 * (left out for unresolved), and an assignee (left out for everyone).
 */
const errorsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/errors",
  staticData: { title: "Errors", access: "errors" },
  validateSearch: (
    search: ErrorSearchInput & { status?: unknown; assignee?: unknown; error?: unknown },
  ): ReturnType<typeof rangeSearch> & { env: string | undefined } & {
    status: StatusFilter | undefined;
    assignee: AssigneeFilter | undefined;
    error: string | undefined;
  } => ({
    ...rangeSearch(search),
    ...environmentSearch(search),
    status:
      isStatusFilter(search.status) && search.status !== DEFAULT_STATUS_FILTER
        ? search.status
        : undefined,
    assignee:
      isAssigneeFilter(search.assignee) && search.assignee !== DEFAULT_ASSIGNEE_FILTER
        ? search.assignee
        : undefined,
    // The workbench's selected group (docs/design-system.md, "Workbench").
    error: typeof search.error === "string" && search.error !== "" ? search.error : undefined,
  }),
  component: withPage(ErrorsPage, function ErrorsRouteComponent() {
    const { projectId } = errorsRoute.useParams();
    const { period, from, to, env, status, assignee } = errorsRoute.useSearch();
    return (
      <ErrorsPage
        projectId={projectId}
        range={rangeFrom({ period, from, to })}
        environment={env ?? DEFAULT_ENVIRONMENT}
        status={status ?? DEFAULT_STATUS_FILTER}
        assignee={assignee ?? DEFAULT_ASSIGNEE_FILTER}
      />
    );
  }),
});

const errorRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/errors/$fingerprint",
  staticData: { title: "Error", access: "errors" },
  validateSearch: (search: ErrorSearchInput) => ({
    ...rangeSearch(search),
    ...environmentSearch(search),
  }),
  component: withPage(ErrorPage, function ErrorRouteComponent() {
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
  }),
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
    search: ErrorSearchInput & {
      path?: unknown;
      user?: unknown;
      error?: unknown;
      min?: unknown;
      replay?: unknown;
    },
  ) => {
    const filters = replayFiltersFrom(search);
    return {
      ...rangeSearch(search),
      ...environmentSearch(search),
      path: filters.path,
      user: filters.userId,
      error: filters.fingerprint,
      min: filters.minDuration,
      // The workbench's selected replay (docs/design-system.md, "Workbench").
      replay: selectionFrom(search.replay),
    };
  },
  component: withPage(ReplaysPage, function ReplaysRouteComponent() {
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
  }),
});

const replayRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/replays/$replayId",
  staticData: { title: "Replay", access: "replays" },
  component: withPage(ReplayPage, function ReplayRouteComponent() {
    const { projectId, replayId } = replayRoute.useParams();
    return <ReplayPage projectId={projectId} replayId={replayId} key={replayId} />;
  }),
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
  component: withPage(SpeedPage, function SpeedRouteComponent() {
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
  }),
});

/** Clicks and scroll depth of one page: days and environment as on Speed, a page, and a device. */
const heatmapsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/heatmaps",
  staticData: { title: "Heatmaps", access: "web_analytics" },
  validateSearch: (
    search: ErrorSearchInput & { path?: unknown; device?: unknown },
  ): ReturnType<typeof rangeSearch> & { env: string | undefined } & {
    path: string | undefined;
    device: DeviceChoice | undefined;
  } => ({
    ...rangeSearch(search),
    ...environmentSearch(search),
    path: pathFrom(search.path),
    device: isDeviceChoice(search.device) ? search.device : undefined,
  }),
  component: withPage(HeatmapsPage, function HeatmapsRouteComponent() {
    const { projectId } = heatmapsRoute.useParams();
    const { period, from, to, env, path, device } = heatmapsRoute.useSearch();
    return (
      <HeatmapsPage
        projectId={projectId}
        range={rangeFrom({ period, from, to })}
        environment={env ?? DEFAULT_ENVIRONMENT}
        path={path}
        device={device}
      />
    );
  }),
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
      trace?: unknown;
      at?: unknown;
      span?: unknown;
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
      trace: isTraceId(search.trace) ? search.trace.toLowerCase() : undefined,
      ...traceSpanSearch(search),
    };
  },
  component: withPage(TracesPage, function TracesRouteComponent() {
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
  }),
});

/** An ISO time in UTC, as the API takes it: when the trace is known to have run. */
const isMoment = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/.test(value) &&
  !Number.isNaN(Date.parse(value));

function traceSpanSearch(search: { at?: unknown; span?: unknown }): {
  at: string | undefined;
  span: string | undefined;
} {
  return {
    at: isMoment(search.at) ? search.at : undefined,
    span:
      typeof search.span === "string" && /^[0-9a-f]{16}$/.test(search.span)
        ? search.span
        : undefined,
  };
}

/**
 * One trace. `at` (when it ran, from an error or a list) narrows where it
 * is looked for; `span` is the span shown, so a link can open on it.
 */
const traceRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/traces/$traceId",
  staticData: { title: "Trace", access: "monitoring" },
  validateSearch: (search: { at?: unknown; span?: unknown } & SearchSchemaInput) =>
    traceSpanSearch(search),
  component: withPage(TracePage, function TraceRouteComponent() {
    const { projectId, traceId } = traceRoute.useParams();
    const { at, span } = traceRoute.useSearch();
    return <TracePage projectId={projectId} traceId={traceId} at={at} spanId={span} />;
  }),
});

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
      log?: unknown;
      live?: unknown;
      start?: unknown;
      end?: unknown;
    },
  ) => {
    const filters = logFiltersFrom(search);
    // A time window from an alert's link (docs/telemetry.md, "The dashboard").
    const window = logWindowFrom(search);
    return {
      ...rangeSearch(search),
      start: window?.start,
      end: window?.end,
      ...environmentSearch(search),
      // The live view (docs/dashboard.md, "Live").
      live: search.live === true || search.live === "true" ? true : undefined,
      service: filters.service,
      severity: filters.severity,
      q: filters.search,
      trace: filters.traceId,
      // The workbench's selected record (docs/design-system.md, "Workbench").
      log: selectionFrom(search.log),
    };
  },
  component: withPage(LogsPage, function LogsRouteComponent() {
    const { projectId } = logsRoute.useParams();
    const { period, from, to, env, service, severity, q, trace, live, start, end } =
      logsRoute.useSearch();
    return (
      <LogsPage
        projectId={projectId}
        range={rangeFrom({ period, from, to })}
        window={start === undefined || end === undefined ? undefined : { start, end }}
        environment={env ?? DEFAULT_ENVIRONMENT}
        filters={{ service, severity, search: q, traceId: trace }}
        live={live === true}
      />
    );
  }),
});

const metricsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/metrics",
  staticData: { title: "Metrics", access: "monitoring" },
  validateSearch: (search: ErrorSearchInput) => ({
    ...rangeSearch(search),
    ...environmentSearch(search),
  }),
  component: withPage(MetricsPage, function MetricsRouteComponent() {
    const { projectId } = metricsRoute.useParams();
    const { period, from, to, env } = metricsRoute.useSearch();
    return (
      <MetricsPage
        projectId={projectId}
        range={rangeFrom({ period, from, to })}
        environment={env ?? DEFAULT_ENVIRONMENT}
      />
    );
  }),
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
  component: withPage(MetricPage, function MetricRouteComponent() {
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
  }),
});

const servicesRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/services",
  staticData: { title: "Services", access: "monitoring" },
  validateSearch: (search: ErrorSearchInput & { service?: unknown; route?: unknown }) => ({
    ...rangeSearch(search),
    ...environmentSearch(search),
    ...serviceChoiceFrom(search),
  }),
  component: withPage(ServicesPage, function ServicesRouteComponent() {
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
  }),
});

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
  component: withPage(ServicePage, function ServiceRouteComponent() {
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
  }),
});

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
  component: withPage(DatabasesPage, function DatabasesRouteComponent() {
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
  }),
});

const queryShapeRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/databases/$shapeId",
  staticData: { title: "Query shape", access: "monitoring" },
  validateSearch: (search: ErrorSearchInput) => ({
    ...rangeSearch(search),
    ...environmentSearch(search),
  }),
  component: withPage(QueryShapePage, function QueryShapeRouteComponent() {
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
  }),
});

const aiRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/ai",
  staticData: { title: "AI", access: "ai" },
  validateSearch: (
    search: ErrorSearchInput & {
      service?: unknown;
      provider?: unknown;
      model?: unknown;
      feature?: unknown;
    },
  ) => ({
    ...rangeSearch(search),
    ...environmentSearch(search),
    ...aiFiltersFrom(search),
  }),
  component: withPage(AiPage, function AiRouteComponent() {
    const { projectId } = aiRoute.useParams();
    const { period, from, to, env, service, provider, model, feature } = aiRoute.useSearch();
    return (
      <AiPage
        projectId={projectId}
        range={rangeFrom({ period, from, to })}
        environment={env ?? DEFAULT_ENVIRONMENT}
        filters={{ service, provider, model, feature }}
      />
    );
  }),
});

type AiCallsSearchInput = ErrorSearchInput & {
  service?: unknown;
  provider?: unknown;
  model?: unknown;
  feature?: unknown;
  user?: unknown;
  conversation?: unknown;
  status?: unknown;
};

function aiCallsSearch(search: AiCallsSearchInput) {
  const filters = aiCallFiltersFrom(search);
  return {
    ...rangeSearch(search),
    ...environmentSearch(search),
    service: filters.service,
    provider: filters.provider,
    model: filters.model,
    feature: filters.feature,
    user: filters.user,
    status: filters.failed === true ? ("failed" as const) : undefined,
    conversation: filters.conversation,
  };
}

const aiCallFilters = (search: ReturnType<typeof aiCallsSearch>) => ({
  service: search.service,
  provider: search.provider,
  model: search.model,
  feature: search.feature,
  user: search.user,
  conversation: search.conversation,
  failed: search.status === "failed" ? true : undefined,
});

/**
 * The AI calls (docs/ai-usage.md, "The calls list"): days, environment,
 * the list's filters, the view (every call, or their conversations), and
 * the workbench's selected call and when it ran. In the Conversations
 * view, `conversation` is the selected conversation.
 */
const aiCallsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/ai/calls",
  staticData: { title: "AI calls", access: "ai" },
  validateSearch: (
    search: AiCallsSearchInput & { view?: unknown; call?: unknown; at?: unknown },
  ) => {
    const view = aiCallsViewFrom(search.view);
    return {
      ...aiCallsSearch(search),
      view: view === "conversations" ? view : undefined,
      call: view === "calls" && isCallId(search.call) ? search.call : undefined,
      at: isMoment(search.at) ? search.at : undefined,
    };
  },
  component: withPage(AiCallsPage, function AiCallsRouteComponent() {
    const { projectId } = aiCallsRoute.useParams();
    const search = aiCallsRoute.useSearch();
    return (
      <AiCallsPage
        projectId={projectId}
        range={rangeFrom(search)}
        environment={search.env ?? DEFAULT_ENVIRONMENT}
        filters={aiCallFilters(search)}
        view={aiCallsViewFrom(search.view)}
        at={search.at}
      />
    );
  }),
});

/** One AI call: when it ran (`at`), and the list it came from, for the way back. */
const aiCallRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/ai/calls/$callId",
  staticData: { title: "AI call", access: "ai" },
  validateSearch: (search: AiCallsSearchInput & { at?: unknown }) => ({
    ...aiCallsSearch(search),
    at: isMoment(search.at) ? search.at : undefined,
  }),
  component: withPage(AiCallPage, function AiCallRouteComponent() {
    const { projectId, callId } = aiCallRoute.useParams();
    const search = aiCallRoute.useSearch();
    return (
      <AiCallPage
        place={{
          projectId,
          range: rangeFrom(search),
          environment: search.env ?? DEFAULT_ENVIRONMENT,
          filters: aiCallFilters(search),
        }}
        callId={callId}
        at={search.at}
      />
    );
  }),
});

/** One conversation's calls: the days, environment, and filters of the list it came from. */
const aiConversationRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/ai/conversations/$conversationId",
  staticData: { title: "Conversation", access: "ai" },
  validateSearch: (search: AiCallsSearchInput) => ({
    ...aiCallsSearch(search),
    conversation: undefined,
  }),
  component: withPage(AiConversationPage, function AiConversationRouteComponent() {
    const { projectId, conversationId } = aiConversationRoute.useParams();
    const search = aiConversationRoute.useSearch();
    return (
      <AiConversationPage
        place={{
          projectId,
          range: rangeFrom(search),
          environment: search.env ?? DEFAULT_ENVIRONMENT,
          filters: aiCallFilters(search),
        }}
        conversationId={conversationId}
      />
    );
  }),
});

const hostsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/hosts",
  staticData: { title: "Hosts", access: "monitoring" },
  validateSearch: (search: ErrorSearchInput) => ({
    ...rangeSearch(search),
    ...environmentSearch(search),
  }),
  component: withPage(HostsPage, function HostsRouteComponent() {
    const { projectId } = hostsRoute.useParams();
    const { period, from, to, env } = hostsRoute.useSearch();
    return (
      <HostsPage
        projectId={projectId}
        range={rangeFrom({ period, from, to })}
        environment={env ?? DEFAULT_ENVIRONMENT}
      />
    );
  }),
});

const hostRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/hosts/$host",
  staticData: { title: "Host", access: "monitoring" },
  validateSearch: (search: ErrorSearchInput) => ({
    ...rangeSearch(search),
    ...environmentSearch(search),
  }),
  component: withPage(HostPage, function HostRouteComponent() {
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
  }),
});

const uptimeRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/uptime",
  staticData: { title: "Uptime", access: "uptime_alerts" },
  validateSearch: (
    search: { period?: unknown; from?: unknown; to?: unknown; check?: unknown } & SearchSchemaInput,
  ) => ({
    ...rangeSearch(search),
    // The workbench's selected check, whose detail shows these days.
    check: selectionFrom(search.check),
  }),
  component: withPage(UptimePage, function UptimeRouteComponent() {
    const { projectId } = uptimeRoute.useParams();
    const { period, from, to } = uptimeRoute.useSearch();
    return <UptimePage projectId={projectId} range={rangeFrom({ period, from, to })} />;
  }),
});

const checkRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/uptime/$checkId",
  staticData: { title: "Check", access: "uptime_alerts" },
  validateSearch: (
    search: { period?: unknown; from?: unknown; to?: unknown } & SearchSchemaInput,
  ) => rangeSearch(search),
  component: withPage(CheckPage, function CheckRouteComponent() {
    const { projectId, checkId } = checkRoute.useParams();
    const { period, from, to } = checkRoute.useSearch();
    return (
      <CheckPage projectId={projectId} checkId={checkId} range={rangeFrom({ period, from, to })} />
    );
  }),
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
      rule?: unknown;
    } & SearchSchemaInput,
  ): {
    rule: string | undefined;
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
    // The workbench's selected rule (docs/design-system.md, "Workbench").
    rule: typeof search.rule === "string" && UUID.test(search.rule) ? search.rule : undefined,
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
  component: withPage(AlertsPage, function AlertsRouteComponent() {
    const { projectId } = alertsRoute.useParams();
    const search = alertsRoute.useSearch();
    return <AlertsPage projectId={projectId} prefill={search} />;
  }),
});

/** One alert rule, for deep links and narrow screens. */
const ruleRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/alerts/$ruleId",
  staticData: { title: "Rule", access: "uptime_alerts" },
  component: withPage(RulePage, function RuleRouteComponent() {
    const { projectId, ruleId } = ruleRoute.useParams();
    return <RulePage projectId={projectId} ruleId={ruleId} key={ruleId} />;
  }),
});

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
  component: withPage(EventsPage, function ProductEventsRouteComponent() {
    const { projectId } = productEventsRoute.useParams();
    const { period, from, to, env } = productEventsRoute.useSearch();
    return (
      <EventsPage
        projectId={projectId}
        range={rangeFrom({ period, from, to })}
        environment={env ?? DEFAULT_ENVIRONMENT}
      />
    );
  }),
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
  ): ReturnType<typeof productRangeSearch> & FilterSearch & Filters => ({
    ...productRangeSearch(search),
    // The lists' filters, named as the Analytics page's.
    ...filtersFrom(search),
    ...filterSearchOf(propertyFiltersFrom(search)),
  }),
  component: withPage(EventPage, function ProductEventRouteComponent() {
    const { projectId, name } = productEventRoute.useParams();
    const { period, from, to, env, ...rest } = productEventRoute.useSearch();
    return (
      <EventPage
        projectId={projectId}
        name={name}
        range={rangeFrom({ period, from, to })}
        environment={env ?? DEFAULT_ENVIRONMENT}
        filters={propertyFiltersFrom(rest)}
        dimensionSearch={rest}
      />
    );
  }),
});

/**
 * The funnel: its steps as the JSON the API takes, who it counts (left out
 * for visitors), and its window in seconds (left out for a day). A window
 * visitors cannot have falls back to a day. `funnel` is the saved funnel
 * last opened or saved, by ID; the steps stay in the address all the same,
 * so a link shows what was viewed. `by` is the breakdown under the result
 * ("deviceType" …, or "p.<property>"), left out for none.
 * `start` is an event name from an event's page: without steps, the page
 * opens New funnel with it as step 1, then drops it from the address.
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
      by?: unknown;
      start?: unknown;
    },
  ): ReturnType<typeof productRangeSearch> & {
    funnel: string | undefined;
    steps: FunnelStep[] | undefined;
    count: "users" | undefined;
    window: FunnelWindow | undefined;
    by: FunnelBreakdownBy | undefined;
    start: string | undefined;
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
      by: steps.length > 0 && isBreakdownBy(search.by) ? search.by : undefined,
      start: steps.length === 0 ? startEventFrom(search.start) : undefined,
    };
  },
  component: withPage(FunnelPage, function ProductFunnelRouteComponent() {
    const { projectId } = productFunnelRoute.useParams();
    const { period, from, to, env, funnel, steps, count, window, by, start } =
      productFunnelRoute.useSearch();
    return (
      <FunnelPage
        projectId={projectId}
        range={rangeFrom({ period, from, to })}
        environment={env ?? DEFAULT_ENVIRONMENT}
        funnel={funnel}
        steps={steps ?? []}
        count={count ?? "visitors"}
        window={window ?? DEFAULT_FUNNEL_WINDOW}
        by={by}
        start={start}
      />
    );
  }),
});

const productRetentionRoute = createRoute({
  getParentRoute: () => productRoute,
  path: "/retention",
  validateSearch: productRangeSearch,
  component: withPage(RetentionPage, function ProductRetentionRouteComponent() {
    const { projectId } = productRetentionRoute.useParams();
    const { period, from, to, env } = productRetentionRoute.useSearch();
    return (
      <RetentionPage
        projectId={projectId}
        range={rangeFrom({ period, from, to })}
        environment={env ?? DEFAULT_ENVIRONMENT}
      />
    );
  }),
});

const productActiveUsersRoute = createRoute({
  getParentRoute: () => productRoute,
  path: "/active-users",
  validateSearch: productRangeSearch,
  component: withPage(ActiveUsersPage, function ProductActiveUsersRouteComponent() {
    const { projectId } = productActiveUsersRoute.useParams();
    const { period, from, to, env } = productActiveUsersRoute.useSearch();
    return (
      <ActiveUsersPage
        projectId={projectId}
        range={rangeFrom({ period, from, to })}
        environment={env ?? DEFAULT_ENVIRONMENT}
      />
    );
  }),
});

const projectSettingsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/settings",
  staticData: { title: "Settings", access: "project_settings" },
  // The chosen tab (SettingsTabs), left out for the first.
  validateSearch: (search: { tab?: unknown } & SearchSchemaInput): { tab: string | undefined } => ({
    tab: typeof search.tab === "string" && search.tab !== "" ? search.tab : undefined,
  }),
  component: withPage(ProjectSettingsPage, function ProjectSettingsRouteComponent() {
    const { projectId } = projectSettingsRoute.useParams();
    return <ProjectSettingsPage projectId={projectId} />;
  }),
});

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  staticData: { title: "Settings" },
  // The chosen tab (SettingsTabs), left out for the first the user may see;
  // `show=no-price` lists only the AI models without a price (ai-models-tab.tsx).
  validateSearch: (
    search: { tab?: unknown; show?: unknown } & SearchSchemaInput,
  ): { tab: string | undefined; show: "no-price" | undefined } => ({
    tab: typeof search.tab === "string" && search.tab !== "" ? search.tab : undefined,
    show: search.show === "no-price" ? "no-price" : undefined,
  }),
  component: SettingsPage,
});

/** The signed-in user's own account: every user has it (docs/dashboard.md). */
const accountRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/account",
  staticData: { title: "Account settings" },
  // The chosen tab (SettingsTabs), left out for the first.
  validateSearch: (search: { tab?: unknown } & SearchSchemaInput): { tab: string | undefined } => ({
    tab: typeof search.tab === "string" && search.tab !== "" ? search.tab : undefined,
  }),
  component: AccountPage,
});

/** The signed-in user's notifications, all or unread (docs/dashboard.md). */
const notificationsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/notifications",
  staticData: { title: "Notifications" },
  validateSearch: (
    search: { filter?: unknown } & SearchSchemaInput,
  ): { filter: "unread" | undefined } => ({
    filter: search.filter === "unread" ? "unread" : undefined,
  }),
  component: withPage(NotificationsPage, function NotificationsRouteComponent() {
    const { filter } = notificationsRoute.useSearch();
    return <NotificationsPage filter={filter ?? "all"} />;
  }),
});

/** Members and invitations, for the owner and admins (docs/access.md). */
const membersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings/members",
  staticData: { title: "Members" },
  // The chosen tab: Members, the first, leaves it out; `?tab=invitations`.
  validateSearch: (search: { tab?: unknown } & SearchSchemaInput): { tab: string | undefined } => ({
    tab: typeof search.tab === "string" && search.tab !== "" ? search.tab : undefined,
  }),
  component: withPage(MembersPage, function MembersRouteComponent() {
    return <MembersPage />;
  }),
});

const routeTree = rootRoute.addChildren([
  signInRoute,
  setupRoute,
  inviteRoute,
  forgotPasswordRoute,
  resetPasswordRoute,
  appRoute.addChildren([
    homeRoute,
    projectsRoute,
    projectRoute.addChildren([
      projectIndexRoute,
      overviewRoute,
      webAnalyticsRoute,
      rightNowRoute,
      speedRoute,
      heatmapsRoute,
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
      aiRoute,
      aiCallsRoute,
      aiCallRoute,
      aiConversationRoute,
      hostsRoute,
      hostRoute,
      uptimeRoute,
      checkRoute,
      alertsRoute,
      ruleRoute,
      productRoute.addChildren([
        productIndexRoute,
        productEventsRoute,
        productEventRoute,
        productFunnelRoute,
        productRetentionRoute,
        productActiveUsersRoute,
      ]),
      projectSettingsRoute,
      unknownProjectPageRoute,
    ]),
    settingsRoute,
    membersRoute,
    accountRoute,
    notificationsRoute,
    unknownAddressRoute,
  ]),
]);

/** Creates an isolated query cache so router instances share no cached state. */
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
      onError: (error) => {
        if (error instanceof ApiError && error.status === 401) {
          // Prevent the next user from seeing this user's cached data.
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
    // Preload chunks and route checks after 50ms of hover or focus to reduce click latency.
    defaultPreload: "intent",
    // Delay skeletons by pendingMs (1s); keep them for pendingMinMs (0.5s) to avoid flashes.
    defaultPendingComponent: PagePending,
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: RouteNotFound,
    parseSearch: parseSearchWith(parseExactJson),
    stringifySearch: stringifySearchWith(JSON.stringify, parseExactJson),
    Wrap: ({ children }: { children: React.ReactNode }) => (
      // Base UI's own <style> elements stay off: the dashboard's Content Security Policy allows
      // stylesheets only, and globals.css carries the one rule they add (base-ui-disable-scrollbar).
      <CSPProvider disableStyleElements>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>{children}</TooltipProvider>
        </QueryClientProvider>
      </CSPProvider>
    ),
  });
  router.subscribe("onBeforeNavigate", ({ fromLocation }) => {
    // Exclude the initial load from navigation tracking.
    if (fromLocation !== undefined) {
      markNavigated(router);
    }
  });
  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
  interface StaticDataRouteOption {
    /** The page header's title (and the tab's), unless the page names its item (`PageTitle`). */
    title?: string;
    /** What a project page needs (docs/access.md); without it, the page says so. */
    access?: PageAccess;
  }
}
