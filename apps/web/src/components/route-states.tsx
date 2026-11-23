import {
  type ErrorComponentProps,
  useMatch,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import {
  ChevronRightIcon,
  CircleArrowUpIcon,
  RotateCwIcon,
  ServerOffIcon,
  TriangleAlertIcon,
} from "lucide-react";
import * as React from "react";

import { ButtonLink } from "@/components/button-link";
import { TruncatedText } from "@/components/truncated-text";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AuthLayout } from "@/features/auth/auth-layout";
import { ApiError, isUnreachable } from "@/lib/api";
import { useShowStatusTitle } from "@/lib/document-title";
import { PageLoadError } from "@/lib/lazy-page";
import { hasNavigated } from "@/lib/navigations";
import { reloadPage } from "@/lib/reload";

/** Match the common page shape while route code loads (docs/design-system.md, "Data states"). */
export function PagePending() {
  return (
    <output
      data-slot="page-pending"
      className="flex flex-col gap-6 px-gutter py-4"
      aria-label="Loading the page"
    >
      {/* Read out as the region's text; the skeleton's shapes say nothing. */}
      <span className="sr-only">Loading the page…</span>
      <div className="flex flex-wrap gap-2" aria-hidden="true">
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-8 w-28" />
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4" aria-hidden="true">
        {["a", "b", "c", "d"].map((key) => (
          <div key={key} className="flex flex-col gap-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-7 w-24" />
          </div>
        ))}
      </div>
      <Skeleton className="h-36 w-full" aria-hidden="true" />
      <div className="flex flex-col gap-2" aria-hidden="true">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    </output>
  );
}

export function AuthPending() {
  return (
    <main
      data-slot="page-pending"
      className="flex min-h-svh flex-col items-center bg-canvas px-gutter py-8 sm:justify-center sm:py-12"
    >
      <output className="sr-only" aria-label="Loading the page">
        Loading the page…
      </output>
      <div className="flex w-full max-w-[26rem] min-w-0 flex-col gap-6" aria-hidden="true">
        <Skeleton className="h-6 w-28" />
        <div className="flex flex-col gap-4 sm:rounded-xl sm:bg-background sm:p-8 sm:ring-1 sm:ring-border">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-24" />
        </div>
      </div>
    </main>
  );
}

/**
 * Where a state that replaces a page shows: centred in the shell's content
 * panel, or alone in the panel the pages before signing in use (AuthLayout).
 */
export type Placement = "shell" | "alone";

/**
 * The shell is there for a route below the app route ("/app"): the app
 * route's own failure (the session check) and the routes before signing
 * in come before it.
 */
function usePlacement(): Placement {
  const routeId: string | undefined = useMatch({
    strict: false,
    select: (match): string | undefined => match.routeId,
  });
  return routeId?.startsWith("/app/") ? "shell" : "alone";
}

/** "Page not found · Acme – Ottertrail" in the tab while the state shows. */
const useTabTitle = useShowStatusTitle;

/**
 * Focus the heading and announce errors after navigation. On first load, read from the top
 * (docs/design-system.md, "Data states").
 */
function PageState({
  placement,
  mark,
  title,
  alert = false,
  children,
  actions,
  details,
}: {
  placement: Placement;
  mark: React.ReactNode;
  title: string;
  alert?: boolean;
  children?: React.ReactNode;
  actions: React.ReactNode;
  details?: React.ReactNode;
}) {
  const router = useRouter();
  const [navigated] = React.useState(() => hasNavigated(router));
  const heading = React.useRef<HTMLHeadingElement>(null);
  const id = React.useId();
  React.useEffect(() => {
    if (navigated) heading.current?.focus();
  }, [navigated]);
  useTabTitle(title);
  // The shell's header holds the page's h1.
  const Heading = placement === "shell" ? "h2" : "h1";
  const state = (
    <div
      data-slot="page-state"
      role={alert && navigated ? "alert" : undefined}
      aria-labelledby={id}
      className="flex w-full max-w-md min-w-0 flex-col items-center gap-5 text-center"
    >
      <div aria-hidden="true">{mark}</div>
      <div className="flex w-full min-w-0 flex-col items-center gap-1.5">
        <Heading
          ref={heading}
          id={id}
          tabIndex={-1}
          className="text-card-title text-balance text-ink outline-none"
        >
          {title}
        </Heading>
        {children}
      </div>
      <div className="flex flex-wrap justify-center gap-2">{actions}</div>
      {details}
    </div>
  );
  return placement === "shell" ? (
    <div className="flex min-h-full items-center justify-center px-gutter py-12">{state}</div>
  ) : (
    <AuthLayout>{state}</AuthLayout>
  );
}

function StatusNumber({ children }: { children: string }) {
  return <p className="text-display-lg text-ink-subtle/40 tabular-nums select-none">{children}</p>;
}

function StateIcon({ icon: Icon }: { icon: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="flex size-12 items-center justify-center rounded-full bg-muted text-ink-subtle">
      <Icon className="size-5" />
    </div>
  );
}

/** Render in the signed-in shell or AuthLayout, depending on the route. */
export function NotFound({
  title = "Page not found",
  line,
  placement,
}: {
  title?: string;
  /** Why, when the title alone does not say (a project the person may not reach). */
  line?: string;
  placement?: Placement;
}) {
  const router = useRouter();
  const routePlacement = usePlacement();
  const address = useRouterState({ select: (state) => state.location.href });
  return (
    <PageState
      placement={placement ?? routePlacement}
      mark={<StatusNumber>404</StatusNumber>}
      title={title}
      actions={
        <>
          <ButtonLink to="/projects">Go to projects</ButtonLink>
          {router.history.canGoBack() && (
            <Button variant="outline" onClick={() => router.history.back()}>
              Go back
            </Button>
          )}
        </>
      }
    >
      {line !== undefined && <p className="text-sm text-pretty text-ink-subtle">{line}</p>}
      <p className="w-full min-w-0 font-mono text-xs text-ink-subtle">
        <span className="sr-only">Address: </span>
        <TruncatedText text={address} />
      </p>
    </PageState>
  );
}

export function RouteNotFound() {
  return <NotFound />;
}

type ErrorKind = "unreachable" | "updated" | "other";

function errorKind(error: unknown): ErrorKind {
  if (error instanceof PageLoadError) return "updated";
  if (isUnreachable(error)) return "unreachable";
  return "other";
}

const ERROR_COPY: Record<
  ErrorKind,
  { title: string; line: string; icon: React.ComponentType<{ className?: string }> }
> = {
  unreachable: {
    title: "Can't reach the server",
    line: "The API didn't answer. It may be restarting, or you may be offline.",
    icon: ServerOffIcon,
  },
  // A tab open across a deploy asks for files the new version no longer has.
  updated: {
    title: "Ottertrail was updated",
    line: "Reload to get the new version.",
    icon: CircleArrowUpIcon,
  },
  other: {
    title: "Something went wrong",
    line: "Reload the page to try again.",
    icon: TriangleAlertIcon,
  },
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function errorDetails(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const head =
    error instanceof ApiError
      ? error.status === 0
        ? error.message
        : `HTTP ${error.status}: ${error.message}`
      : `${error.name}: ${error.message}`;
  // The browser's reason a page's code did not download; a loader's wrapped error.
  return error.cause === undefined ? head : `${head}\n${messageOf(error.cause)}`;
}

/**
 * Retry API failures (network, 502, 503, 504) in place. Reload failed modules
 * because browsers cache import failures.
 */
export function ErrorState({ error, placement }: { error: unknown; placement: Placement }) {
  const router = useRouter();
  const [retrying, setRetrying] = React.useState(false);
  const kind = errorKind(error);
  const copy = ERROR_COPY[kind];
  const retry = () => {
    setRetrying(true);
    void router.invalidate().finally(() => setRetrying(false));
  };
  const reload = (
    <Button variant={kind === "unreachable" ? "outline" : "default"} onClick={reloadPage}>
      <RotateCwIcon data-icon="inline-start" />
      Reload
    </Button>
  );
  return (
    <PageState
      placement={placement}
      mark={<StateIcon icon={copy.icon} />}
      title={copy.title}
      alert
      actions={
        kind === "unreachable" ? (
          <>
            <Button onClick={retry} disabled={retrying}>
              {retrying ? "Trying again…" : "Try again"}
            </Button>
            {reload}
          </>
        ) : (
          reload
        )
      }
      details={
        <details className="group w-full">
          <summary className="mx-auto flex w-fit cursor-pointer list-none items-center gap-1 rounded-md px-1.5 py-1 text-xs text-ink-subtle outline-none hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon
              aria-hidden="true"
              className="size-3.5 transition-transform group-open:rotate-90"
            />
            Details
          </summary>
          <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-muted px-3 py-2 text-left font-mono text-xs [overflow-wrap:anywhere] whitespace-pre-wrap text-ink-muted">
            {errorDetails(error)}
          </pre>
        </details>
      }
    >
      <p className="text-sm text-pretty text-ink-subtle">{copy.line}</p>
    </PageState>
  );
}

/** Keep the shell available after app-route failures. Earlier failures use AuthLayout. */
export function RouteError({ error }: ErrorComponentProps) {
  return <ErrorState error={error} placement={usePlacement()} />;
}
