import { CSPProvider } from "@base-ui/react/csp-provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RouterHistory } from "@tanstack/react-router";
import * as React from "react";

import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiError } from "@/lib/api";
import { shareTokenOf } from "@/lib/share-links-api";

import { NoLink, ShareApp } from "./share-app";

const isClientError = (error: unknown) =>
  error instanceof ApiError && error.status >= 400 && error.status < 500;

/** The shared link's page with its providers, for share.html and the browser tests. */
export function ShareRoot({
  history,
  retryDelayMs,
}: {
  history: RouterHistory;
  /** Wait before retrying a failed request; React Query's backoff when left out. Tests set 0. */
  retryDelayMs?: number;
}) {
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            // A 4xx answer (a revoked link, a limit) will not change on a retry.
            retry: (failures, error) => !isClientError(error) && failures < 2,
            ...(retryDelayMs === undefined ? {} : { retryDelay: retryDelayMs }),
          },
        },
      }),
  );
  const token = shareTokenOf(history.location.pathname);
  return (
    // Base UI's own <style> elements stay off, as on the dashboard (router.tsx).
    <CSPProvider disableStyleElements>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          {token === null ? <NoLink /> : <ShareApp token={token} history={history} />}
        </TooltipProvider>
      </QueryClientProvider>
    </CSPProvider>
  );
}
