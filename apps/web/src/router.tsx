import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  type RouterHistory,
  type SearchSchemaInput,
} from "@tanstack/react-router";
import type * as React from "react";

import { AppLayout } from "@/app";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AnalyticsPage } from "@/features/analytics/analytics-page";
import { SetupPage } from "@/features/auth/setup-page";
import { SignInPage } from "@/features/auth/sign-in-page";
import { DesignSystemPage } from "@/features/design-system/design-system-page";
import { ProjectLayout } from "@/features/projects/project-layout";
import { ProjectSettingsPage } from "@/features/projects/project-settings-page";
import { ProjectsPage } from "@/features/projects/projects-page";
import { DEFAULT_PERIOD, isPeriod, type Period } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { lastProject } from "@/lib/last-project";
import { projectsQuery } from "@/lib/projects-api";

async function signedIn(): Promise<boolean> {
  const { data } = await authClient.getSession();
  return data !== null;
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
 * Inside one project. Every module (web analytics, and later product
 * analytics, users, errors, email) is a page under it, and the sidebar
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
  validateSearch: (
    search: { period?: unknown } & SearchSchemaInput,
  ): { period: Period | undefined } => ({
    period: isPeriod(search.period) ? search.period : undefined,
  }),
  component: function WebAnalyticsRouteComponent() {
    const { projectId } = webAnalyticsRoute.useParams();
    const { period = DEFAULT_PERIOD } = webAnalyticsRoute.useSearch();
    return <AnalyticsPage projectId={projectId} period={period} />;
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
    projectRoute.addChildren([projectIndexRoute, webAnalyticsRoute, projectSettingsRoute]),
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
