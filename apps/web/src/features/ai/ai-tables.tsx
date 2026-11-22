import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { BreakdownTable } from "@/components/breakdown-table";
import { Missing } from "@/components/missing";
import { PINNED, PINNED_END } from "@/components/pinned-column";
import { ScrollHint } from "@/components/scroll-hint";
import { StatusBadge } from "@/components/status-badge";
import { TruncatedText } from "@/components/truncated-text";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type AiCall,
  aiCallsQuery,
  type AiFeatureRow,
  type AiFilters,
  type AiModelRow,
  type AiReport,
} from "@/lib/ai-api";
import type { PageRange } from "@/lib/analytics-api";
import { MISSING } from "@/lib/missing";

import { formatConversion, formatWhole } from "../analytics/format";
import { aiSearchOf, environmentSearch } from "../telemetry/search";
import { formatMoment } from "../users/format";
import { featureLabel, formatMs, formatTokens, formatUsd, isCutOff, modelLabel } from "./format";

/** Where the page is: what a filter link keeps, and adds its filter to. */
export interface AiPlace {
  projectId: string;
  range: PageRange;
  environment: string;
  filters: AiFilters;
}

const HEAD = "[&_th]:h-8 [&_th]:text-xs [&_th]:font-normal [&_th]:text-ink-subtle";

/** A share with a dash for none: "0.5%", "12%". */
const share = (value: number | null) => (value === null ? MISSING : formatConversion(value));

/**
 * A model's or feature's name, linking to the page filtered by it, as a
 * breakdown row's name does elsewhere; the whole name in a tooltip while it
 * is cut off.
 */
export function FilterName({
  place,
  filter,
  className = "max-w-64 max-sm:max-w-40",
}: {
  place: AiPlace;
  filter: { model: string } | { feature: string };
  className?: string;
}) {
  const isModel = "model" in filter;
  const label = isModel ? modelLabel(filter.model) : featureLabel(filter.feature);
  // A model the spans did not name cannot be asked for: the API takes a name.
  if (isModel && filter.model === "") {
    return <span className="text-ink-subtle">{label}</span>;
  }
  return (
    <TruncatedText
      text={label}
      className={`${className} ${label === featureLabel("") ? "text-ink-subtle" : "text-ink"} hover:text-link hover:underline`}
      render={
        <Link
          to="/projects/$projectId/ai"
          params={{ projectId: place.projectId }}
          search={aiSearchOf({ ...place, filters: { ...place.filters, ...filter } })}
          aria-label={`Filter by ${isModel ? "the model" : "the feature"} ${label}`}
        />
      }
    />
  );
}

/**
 * The calls by model or by feature, the costliest first: calls, tokens,
 * estimated cost, the median and 95th percentile, the median time to the
 * first chunk, and the failed and cut-off shares. A name filters the page.
 */
export function FiguresTable({
  title,
  place,
  kind,
  rows,
  empty,
}: {
  title: string;
  place: AiPlace;
  kind: "model" | "feature";
  rows: (AiModelRow | AiFeatureRow)[];
  empty: string;
}) {
  const headingId = React.useId();
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2 border-t pt-5">
      <h2 id={headingId} className="text-sm font-medium text-ink">
        {title}
      </h2>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-subtle">{empty}</p>
      ) : (
        <ScrollHint>
          <Table className={kind === "model" ? "max-sm:min-w-[56rem]" : "max-sm:min-w-[50rem]"}>
            <caption className="sr-only">
              Calls {kind === "model" ? "by model" : "by feature"}, the costliest first
            </caption>
            <TableHeader className={HEAD}>
              <TableRow>
                <TableHead className={`pl-0 ${PINNED}`}>
                  {kind === "model" ? "Model" : "Feature"}
                </TableHead>
                {kind === "model" && <TableHead>Provider</TableHead>}
                <TableHead className="text-right">Calls</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Est. cost</TableHead>
                <TableHead className="text-right">Median</TableHead>
                <TableHead className="text-right">95th percentile</TableHead>
                <TableHead className="text-right">First chunk</TableHead>
                <TableHead className="text-right">Failed</TableHead>
                <TableHead className="text-right">Cut off</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const isModel = "model" in row;
                const name = isModel ? row.model : row.feature;
                return (
                  <TableRow key={row.other ? "\u0000other" : name}>
                    <TableCell className={`pl-0 ${PINNED}`}>
                      {row.other ? (
                        <span className="text-ink-subtle">
                          {isModel ? "Other models" : "Other features"}
                        </span>
                      ) : (
                        <FilterName
                          place={place}
                          filter={isModel ? { model: row.model } : { feature: row.feature }}
                        />
                      )}
                    </TableCell>
                    {isModel && (
                      <TableCell className="text-ink-subtle">
                        {row.provider === "" ? <Missing label="Not sent" /> : row.provider}
                      </TableCell>
                    )}
                    <TableCell className="text-right tabular-nums">
                      {formatWhole(row.calls)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatTokens(row.inputTokens + row.outputTokens)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {isModel && !row.other && !row.priced ? (
                        <span className="text-ink-subtle">No price</span>
                      ) : (
                        formatUsd(row.costUsd)
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatMs(row.p50Ms)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMs(row.p95Ms)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.firstChunkP50Ms === null ? (
                        <Missing label="Not sent" />
                      ) : (
                        formatMs(row.firstChunkP50Ms)
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {share(row.failedShare)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {share(row.cutOffShare)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </ScrollHint>
      )}
    </section>
  );
}

/** The users whose calls cost the most, each opening the user's page; or why they are hidden. */
export function UsersTable({ place, report }: { place: AiPlace; report: AiReport }) {
  if (report.users === null) {
    return (
      <section aria-labelledby="ai-users" className="flex min-w-0 flex-col gap-2">
        <h2 id="ai-users" className="flex min-h-8 items-center text-sm font-medium text-ink">
          By user
        </h2>
        <p className="border-t py-6 text-sm text-ink-subtle">
          Calls by user need access to the Users area, which an admin can give you on the Members
          page.
        </p>
      </section>
    );
  }
  return (
    <BreakdownTable
      title="By user"
      headingLevel={2}
      caption={`The ${report.limits.users} users whose calls cost the most, the costliest first`}
      nameHeading="User"
      figureHeadings={["Est. cost", "Calls", "Tokens"]}
      rows={report.users.map((user) => ({
        key: user.userId,
        title: user.userId,
        label: (
          <Link
            to="/projects/$projectId/users/$userId"
            params={{ projectId: place.projectId, userId: user.userId }}
            search={environmentSearch(place.environment)}
            className="hover:text-link hover:underline"
          >
            {user.userId}
          </Link>
        ),
        bar: user.costUsd,
        figures: [
          formatUsd(user.costUsd),
          formatWhole(user.calls),
          formatTokens(user.inputTokens + user.outputTokens),
        ],
      }))}
      empty="No call named a user. Set user.id on the calls to see who uses them."
    />
  );
}

/** Failed calls by error type, the most first: each type's calls, share of the failures, and latest. */
export function FailuresTable({ report }: { report: AiReport }) {
  const headingId = React.useId();
  const failed = report.failures.reduce((total, failure) => total + failure.calls, 0);
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2">
      <h2 id={headingId} className="flex min-h-8 items-center text-sm font-medium text-ink">
        Failures
      </h2>
      {report.failures.length === 0 ? (
        <p className="border-t py-6 text-center text-sm text-ink-subtle">
          No call failed in this period.
        </p>
      ) : (
        <ScrollHint>
          <Table className="max-sm:min-w-[28rem]">
            <caption className="sr-only">Failed calls by error type, the most first</caption>
            <TableHeader className={HEAD}>
              <TableRow>
                <TableHead className={`pl-0 ${PINNED}`}>Error type</TableHead>
                <TableHead className="text-right">Calls</TableHead>
                <TableHead className="text-right">Share</TableHead>
                <TableHead className="pr-0 text-right">Latest</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.failures.map((failure) => (
                <TableRow key={failure.errorType}>
                  <TableCell className={`pl-0 ${PINNED}`}>
                    {failure.errorType === "" ? (
                      <span className="text-ink-subtle">No error type</span>
                    ) : (
                      <TruncatedText
                        text={failure.errorType}
                        className="max-w-64 font-mono text-xs max-sm:max-w-40"
                      />
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatWhole(failure.calls)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {share(failed === 0 ? null : failure.calls / failed)}
                  </TableCell>
                  <TableCell className="pr-0 text-right whitespace-nowrap tabular-nums">
                    {formatMoment(failure.lastAt, report.timeZone)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollHint>
      )}
    </section>
  );
}

/**
 * A call's outcome in words, never color alone. A failed call's error
 * type is the badge's explanation (its title, and read out); the Failures
 * table lists the types.
 */
function CallStatus({ call }: { call: AiCall }) {
  if (call.failed) {
    return (
      <StatusBadge tone="critical" title={call.errorType === "" ? undefined : call.errorType}>
        Failed
        {call.errorType !== "" && <span className="sr-only">: {call.errorType}</span>}
      </StatusBadge>
    );
  }
  if (isCutOff(call.finishReasons)) return <StatusBadge tone="warning">Cut off</StatusBadge>;
  return <span className="text-sm text-ink-subtle">OK</span>;
}

/**
 * The latest 50 calls, newest first, each opening its span on its trace's
 * page. Its own request: it loads, fails, and retries apart from the report.
 */
export function RecentCalls({ place }: { place: AiPlace }) {
  const calls = useQuery(
    aiCallsQuery(place.projectId, place.range, place.environment, place.filters),
  );
  const { data } = calls;
  const headingId = React.useId();
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2 border-t pt-5">
      <h2 id={headingId} className="text-sm font-medium text-ink">
        Latest calls
      </h2>
      {calls.isError && (
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertTitle>
            {data === undefined
              ? "The latest calls could not load"
              : "The latest calls could not refresh"}
          </AlertTitle>
          <AlertDescription>
            {calls.error.message}
            {data !== undefined && " The list below is from the last successful load."}
          </AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={() => void calls.refetch()}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      )}
      {data === undefined ? (
        !calls.isError && (
          <div
            className="flex flex-col gap-2"
            aria-busy="true"
            aria-label="Loading the latest calls"
          >
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        )
      ) : data.calls.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-subtle">No AI call in this period.</p>
      ) : (
        <div
          className="transition-opacity data-[stale=true]:opacity-60"
          data-stale={calls.isPlaceholderData}
          aria-busy={calls.isPlaceholderData}
        >
          <ScrollHint>
            <Table className="max-sm:min-w-[60rem]">
              <caption className="sr-only">The latest {data.limit} calls, newest first</caption>
              <TableHeader className={HEAD}>
                <TableRow>
                  <TableHead className="pl-0">Started</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Feature</TableHead>
                  {!data.usersHidden && <TableHead>User</TableHead>}
                  <TableHead className="text-right">Input</TableHead>
                  <TableHead className="text-right">Output</TableHead>
                  <TableHead className="text-right">Est. cost</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className={PINNED_END}>
                    <span className="sr-only">Trace</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.calls.map((call) => (
                  <TableRow key={`${call.traceId}-${call.spanId}`}>
                    <TableCell className="pl-0 whitespace-nowrap tabular-nums">
                      {formatMoment(call.at, data.timeZone)}
                    </TableCell>
                    <TableCell>
                      <FilterName
                        place={place}
                        filter={{ model: call.model }}
                        className="max-w-44"
                      />
                    </TableCell>
                    <TableCell>
                      <FilterName
                        place={place}
                        filter={{ feature: call.feature }}
                        className="max-w-36"
                      />
                    </TableCell>
                    {!data.usersHidden && (
                      <TableCell>
                        {call.userId === null ? (
                          <Missing label="No user" />
                        ) : (
                          <TruncatedText
                            text={call.userId}
                            className="max-w-36 hover:text-link hover:underline"
                            render={
                              <Link
                                to="/projects/$projectId/users/$userId"
                                params={{ projectId: place.projectId, userId: call.userId }}
                                search={environmentSearch(place.environment)}
                              />
                            }
                          />
                        )}
                      </TableCell>
                    )}
                    <TableCell className="text-right tabular-nums">
                      {formatTokens(call.inputTokens)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatTokens(call.outputTokens)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {call.costUsd === null ? (
                        <span className="text-ink-subtle">No price</span>
                      ) : (
                        formatUsd(call.costUsd)
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMs(call.durationMs)}
                    </TableCell>
                    <TableCell>
                      <CallStatus call={call} />
                    </TableCell>
                    <TableCell className={PINNED_END}>
                      <Link
                        to="/projects/$projectId/traces/$traceId"
                        params={{ projectId: place.projectId, traceId: call.traceId }}
                        search={{ at: call.at, span: call.spanId }}
                        className="text-sm whitespace-nowrap text-link hover:underline"
                      >
                        Open its trace
                        <span className="sr-only">
                          {" "}
                          ({modelLabel(call.model)}, {formatMoment(call.at, data.timeZone)})
                        </span>
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollHint>
        </div>
      )}
    </section>
  );
}
