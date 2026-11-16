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
import { authClient } from "@/lib/auth-client";

async function signedIn(): Promise<boolean> {
  const { data } = await authClient.getSession();
  return data !== null;
}

const rootRoute = createRootRoute({
  component: () => (
    <TooltipProvider>
      <Outlet />
    </TooltipProvider>
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

const designSystemRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  component: DesignSystemPage,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    signInRoute,
    setupRoute,
    appRoute.addChildren([designSystemRoute]),
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
