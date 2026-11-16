import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";

import { AppLayout } from "@/app";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SetupPage } from "@/features/auth/setup-page";
import { SignInPage } from "@/features/auth/sign-in-page";
import { DesignSystemPage } from "@/features/design-system/design-system-page";
import { ProjectPage } from "@/features/projects/project-page";
import { ProjectsPage } from "@/features/projects/projects-page";
import { ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

async function signedIn(): Promise<boolean> {
  const { data } = await authClient.getSession();
  return data !== null;
}

const isClientError = (error: unknown) =>
  error instanceof ApiError && error.status >= 400 && error.status < 500;

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
    },
  },
});

const rootRoute = createRootRoute({
  component: () => (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Outlet />
      </TooltipProvider>
    </QueryClientProvider>
  ),
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

/** Projects are the home page until the analytics page exists. */
const homeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/projects" });
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
  staticData: { title: "Project" },
  component: function ProjectRouteComponent() {
    const { projectId } = projectRoute.useParams();
    return <ProjectPage projectId={projectId} />;
  },
});

const designSystemRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/design-system",
  staticData: { title: "Design system" },
  component: DesignSystemPage,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    signInRoute,
    setupRoute,
    appRoute.addChildren([homeRoute, projectsRoute, projectRoute, designSystemRoute]),
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
  interface StaticDataRouteOption {
    /** Shown in the header of signed-in pages. */
    title?: string;
  }
}
