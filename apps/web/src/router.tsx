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
import { TooltipProvider } from "@/components/ui/tooltip";
import { AnalyticsPage } from "@/features/analytics/analytics-page";
import { SetupPage } from "@/features/auth/setup-page";
import { SignInPage } from "@/features/auth/sign-in-page";
import { DesignSystemPage } from "@/features/design-system/design-system-page";
import { ErrorPage } from "@/features/errors/error-page";
import { ErrorsPage } from "@/features/errors/errors-page";
import { OrganizationSettingsPage } from "@/features/organizations/organization-settings-page";
import { ProjectLayout } from "@/features/projects/project-layout";
import { ProjectSettingsPage } from "@/features/projects/project-settings-page";
import { ProjectsPage } from "@/features/projects/projects-page";
import { SpeedPage } from "@/features/speed/speed-page";
import { UserPage } from "@/features/users/user-page";
import { UsersPage } from "@/features/users/users-page";
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
import { DEFAULT_STATUS_FILTER, isStatusFilter, type StatusFilter } from "@/lib/errors-api";
import { lastProject } from "@/lib/last-project";
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
    const projects = await context.queryClient.ensureQueryData(projectsQuery());
    const last = lastProject();
    const project = projects.find((item) => item.id === last) ?? projects[0];
    if (project === undefined) {
      throw redirect({ to: "/projects" });
    }
    throw redirect({
      to: "/projects/$projectId/web-analytics",
      params: { projectId: project.id },
    });
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
 * Inside one project. Every module (web analytics, speed, users, errors, and
 * later product analytics) is a page under it, and the sidebar
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

/** A project opens on its web analytics until it has an overview page. */
const projectIndexRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/",
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/projects/$projectId/web-analytics", params });
  },
});

const webAnalyticsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/web-analytics",
  staticData: { title: "Web analytics" },
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
  staticData: { title: "Users" },
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
  staticData: { title: "User" },
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
  staticData: { title: "Errors" },
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
  staticData: { title: "Error" },
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

/** Web Vitals: days and environment as on errors, and a kind of device (left out for all). */
const speedRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/speed",
  staticData: { title: "Speed" },
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

const projectSettingsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/settings",
  staticData: { title: "Settings" },
  component: function ProjectSettingsRouteComponent() {
    const { projectId } = projectSettingsRoute.useParams();
    return <ProjectSettingsPage projectId={projectId} />;
  },
});

/** The organization's settings: the workspace level, above any one project. */
const organizationSettingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  staticData: { title: "Settings" },
  component: OrganizationSettingsPage,
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
      projectSettingsRoute,
    ]),
    organizationSettingsRoute,
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
  }
}
