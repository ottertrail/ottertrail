import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { OctagonAlertIcon, PlayIcon } from "lucide-react";

import { ButtonLink } from "@/components/button-link";
import { StatusBadge } from "@/components/status-badge";
import { TruncatedText } from "@/components/truncated-text";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAccess } from "@/lib/access";
import { DEFAULT_ENVIRONMENT } from "@/lib/analytics-api";
import { type BrowserTraceError, browserTraceQuery, type BrowserView } from "@/lib/traces-api";

import { formatWhole } from "../analytics/format";
import { dayKey, formatMoment } from "../users/format";

const browserOf = (view: BrowserView) =>
  [[view.browser, view.browserVersion].filter((part) => part !== null).join(" "), view.os]
    .filter((part) => part !== null && part !== "")
    .join(", ") || "(unknown)";

const statusText = (status: number) => (status === 0 ? "No answer" : String(status));

function UserFact({ projectId, view }: { projectId: string; view: BrowserView }) {
  const canOpen = useAccess().canUse("users");
  if (view.userId === null) return <span className="text-ink-subtle">Anonymous</span>;
  if (!canOpen) return <TruncatedText text={view.userId} className="max-w-48 font-mono" />;
  return (
    <TruncatedText
      text={view.userId}
      className="max-w-48 font-mono text-link hover:underline"
      render={
        <Link
          to="/projects/$projectId/users/$userId"
          params={{ projectId, userId: view.userId }}
          search={view.environment === DEFAULT_ENVIRONMENT ? {} : { env: view.environment }}
        />
      }
    />
  );
}

function ErrorRow({
  projectId,
  error,
  timeZone,
}: {
  projectId: string;
  error: BrowserTraceError;
  timeZone: string;
}) {
  const text = `${error.type}${error.message === "" ? "" : `: ${error.message}`}`;
  const day = dayKey(error.occurredAt, timeZone);
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <TruncatedText
          text={text}
          className="max-w-[40rem] text-link hover:underline"
          render={
            <Link
              to="/projects/$projectId/errors/$fingerprint"
              params={{ projectId, fingerprint: error.fingerprint }}
              search={{
                from: day,
                to: day,
                ...(error.environment === DEFAULT_ENVIRONMENT ? {} : { env: error.environment }),
              }}
            />
          }
        >
          <span className="font-medium">{error.type}</span>
          {error.message !== "" && `: ${error.message}`}
        </TruncatedText>
        <time dateTime={error.occurredAt} className="text-xs text-ink-subtle tabular-nums">
          {formatMoment(error.occurredAt, timeZone)}
        </time>
      </div>
      {error.replayId !== null && (
        <ButtonLink
          variant="outline"
          size="sm"
          to="/projects/$projectId/replays/$replayId"
          params={{ projectId, replayId: error.replayId }}
        >
          <PlayIcon aria-hidden="true" />
          Play replay
        </ButtonLink>
      )}
    </li>
  );
}

/**
 * The browser events that name the trace (docs/telemetry.md, "The browser
 * and the server"): the page load it served, or the request it is, and the
 * errors that carry it. Nothing when no browser event names it.
 */
export function BrowserPart({
  projectId,
  traceId,
  at,
}: {
  projectId: string;
  traceId: string;
  /** The trace's start, or the time it was linked from. */
  at: string;
}) {
  const query = useQuery(browserTraceQuery(projectId, traceId, at));
  if (query.isPending) {
    return (
      <div aria-busy="true" aria-label="Loading the browser's part">
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <Alert variant="destructive">
        <OctagonAlertIcon />
        <AlertTitle>The browser&apos;s part could not load</AlertTitle>
        <AlertDescription>{query.error.message}</AlertDescription>
        <AlertAction>
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </AlertAction>
      </Alert>
    );
  }
  const { pageLoad, errors, timeZone } = query.data;
  const view = pageLoad ?? errors[0];
  if (view === undefined) return null;
  const request = pageLoad === null ? errors[0]?.request : null;
  const facts = [
    {
      label: "Page",
      value: <TruncatedText text={view.path || "(none)"} className="max-w-80 font-mono" />,
    },
    { label: "Browser", value: browserOf(view) },
    { label: "Release", value: view.release ?? "(unknown)" },
    ...(query.data.usersHidden
      ? []
      : [{ label: "User", value: <UserFact projectId={projectId} view={view} /> }]),
    ...(request === null || request === undefined
      ? []
      : [
          {
            label: "Request",
            value: (
              <span className="flex flex-wrap items-center gap-2">
                <TruncatedText
                  text={`${request.method} ${request.path}`}
                  className="max-w-80 font-mono"
                />
                {request.status >= 400 || request.status === 0 ? (
                  <StatusBadge tone="critical">{statusText(request.status)}</StatusBadge>
                ) : (
                  <span className="tabular-nums">{statusText(request.status)}</span>
                )}
                <span className="text-ink-subtle tabular-nums">
                  {formatWhole(request.durationMs)} ms
                </span>
              </span>
            ),
          },
        ]),
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3>From the browser</h3>
        </CardTitle>
        <CardDescription>
          {pageLoad !== null
            ? `A page load, at ${formatMoment(pageLoad.occurredAt, timeZone)} in ${timeZone}.`
            : `A request from the page ${view.path || "(none)"}.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 @xl:grid-cols-2">
          {facts.map((fact) => (
            <div key={fact.label} className="flex min-w-0 flex-col gap-1">
              <dt className="text-xs text-ink-subtle">{fact.label}</dt>
              <dd className="min-w-0 text-sm text-ink">{fact.value}</dd>
            </div>
          ))}
        </dl>
        {errors.length > 0 && (
          <section aria-label="Errors" className="flex flex-col gap-1">
            <h4 className="text-xs text-ink-subtle">Errors</h4>
            <ul className="divide-y">
              {errors.map((error) => (
                <ErrorRow
                  key={error.eventId}
                  projectId={projectId}
                  error={error}
                  timeZone={timeZone}
                />
              ))}
            </ul>
          </section>
        )}
      </CardContent>
    </Card>
  );
}
