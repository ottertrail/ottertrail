import type { ErrorComponentProps } from "@tanstack/react-router";
import { OctagonAlertIcon, RotateCwIcon } from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageLoadError } from "@/lib/lazy-page";
import { reloadPage } from "@/lib/reload";

/**
 * A page inside the shell whose code is still downloading, once the router
 * has waited `pendingMs` for it: a filter bar, a strip of figures, and a
 * chart, the shape most pages take (docs/design-system.md, "Data states").
 */
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

/** A page before signing in whose code is still downloading: its panel's shape (AuthLayout). */
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

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * What a route shows when it fails to render. A page whose code could not
 * be downloaded (PageLoadError: a tab left open across a deploy, or the
 * connection dropped) says so and offers to reload, which fetches the
 * current version; trying again in place would fail the same way.
 */
export function RouteError({ error }: ErrorComponentProps) {
  const chunk = error instanceof PageLoadError;
  return (
    <div className="px-gutter py-6">
      <Alert variant="destructive" className="max-w-2xl">
        <OctagonAlertIcon />
        <AlertTitle>{chunk ? "This page could not load" : "Something went wrong"}</AlertTitle>
        <AlertDescription>
          {chunk
            ? `The page download failed (${messageOf(error.cause)}). Reload to try again.`
            : `${messageOf(error)} Reloading the page may help.`}
        </AlertDescription>
        <AlertAction>
          <Button variant="outline" size="sm" onClick={reloadPage}>
            <RotateCwIcon data-icon="inline-start" />
            Reload
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
}
