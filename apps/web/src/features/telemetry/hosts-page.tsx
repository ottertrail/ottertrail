import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { OctagonAlertIcon, SearchXIcon } from "lucide-react";

import { clickableRow, ROW_LINK } from "@/components/clickable-row";
import { Missing } from "@/components/missing";
import { PINNED } from "@/components/pinned-column";
import { ScrollHint } from "@/components/scroll-hint";
import { StatusBadge } from "@/components/status-badge";
import { TruncatedText } from "@/components/truncated-text";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DEFAULT_ENVIRONMENT, type PageRange } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import { hostsQuery } from "@/lib/hosts-api";

import { formatWhole } from "../analytics/format";
import { ReportFilterBar } from "../errors/range-controls";
import { NoSuchProject } from "../projects/no-such-project";
import { formatPreciseMoment } from "./format";
import { formatLoad, formatPercent } from "./host-format";
import { environmentSearch, rangeSearch } from "./search";
import { SendHostMetrics } from "./send-host-metrics";

/** Hide freshness for historical periods; they cannot show the host's current state. */
export function Freshness({ stale }: { stale: boolean | null }) {
  if (stale === null) return null;
  return stale ? (
    <StatusBadge tone="warning">Stale</StatusBadge>
  ) : (
    <StatusBadge tone="good">Reporting</StatusBadge>
  );
}

export const HIGH_PERCENT = 90;

function ShareCell({ percent, detail }: { percent: number | null; detail?: string | null }) {
  if (percent === null) {
    return (
      <TableCell className="text-right">
        <Missing label="Not sent" />
      </TableCell>
    );
  }
  // Rate the rounded value: 89.96 displays as 90%.
  const high = Math.round(percent * 10) / 10 >= HIGH_PERCENT;
  const width = Math.min(100, Math.max(0, percent));
  return (
    <TableCell className="text-right tabular-nums">
      <span className="inline-flex items-center justify-end gap-2 whitespace-nowrap">
        <span
          aria-hidden="true"
          data-slot="share-bar"
          data-high={high}
          className="relative h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-seq-1"
        >
          <span
            className={`absolute inset-y-0 left-0 rounded-full ${high ? "bg-status-warning" : "bg-chart-1"}`}
            style={{ width: `${width}%` }}
          />
        </span>
        <span>
          {formatPercent(percent)}
          {detail === undefined || detail === null || detail === "" ? "" : ` (${detail})`}
        </span>
        {high && <StatusBadge tone="warning">High</StatusBadge>}
      </span>
    </TableCell>
  );
}

function ValueCell({ text }: { text: string | null }) {
  return (
    <TableCell className="text-right tabular-nums">
      {text ?? <Missing label="Not sent" />}
    </TableCell>
  );
}

export function HostsPage({
  projectId,
  range,
  environment = DEFAULT_ENVIRONMENT,
}: {
  projectId: string;
  range: PageRange;
  environment?: string;
}) {
  const navigate = useNavigate();
  const list = useQuery(hostsQuery(projectId, range, environment));
  const show = (next: { range?: PageRange; environment?: string }) =>
    void navigate({
      to: "/projects/$projectId/hosts",
      params: { projectId },
      search: {
        ...rangeSearch(next.range ?? range),
        ...environmentSearch(next.environment ?? environment),
      },
    });

  if (list.error instanceof ApiError && list.error.status === 404) {
    return <NoSuchProject />;
  }
  const data = list.data;

  return (
    <div className="flex flex-col">
      <ReportFilterBar
        range={range}
        environment={environment}
        answered={data}
        onRange={(next) => show({ range: next })}
        onEnvironment={(next) => show({ environment: next })}
      />
      <div className="flex flex-col gap-6 px-gutter py-5">
        {list.isError && (
          <Alert variant="destructive">
            <OctagonAlertIcon />
            <AlertTitle>
              {data === undefined ? "The hosts could not load" : "The hosts could not refresh"}
            </AlertTitle>
            <AlertDescription>
              {list.error.message}
              {data !== undefined && " The list below is from the last successful load."}
            </AlertDescription>
            <AlertAction>
              <Button variant="outline" size="sm" onClick={() => void list.refetch()}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        )}
        {data === undefined ? (
          !list.isError && (
            <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          )
        ) : !data.received ? (
          <SendHostMetrics projectId={projectId} retentionDays={data.retentionDays} />
        ) : (
          <div
            className="flex flex-col gap-4 transition-opacity data-[stale=true]:opacity-60"
            data-stale={list.isPlaceholderData}
            aria-busy={list.isPlaceholderData}
          >
            {data.hosts.length === 0 ? (
              <Empty className="border border-dashed p-10">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <SearchXIcon />
                  </EmptyMedia>
                  <EmptyTitle>No hosts in this period</EmptyTitle>
                  <EmptyDescription>
                    No host metrics arrived
                    {environment === DEFAULT_ENVIRONMENT ? "" : ` in ${environment}`} in this
                    period. Metrics are kept {data.retentionDays} days.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <>
                <ScrollHint>
                  <Table className="max-sm:min-w-[56rem]">
                    <caption className="sr-only">Hosts, by name</caption>
                    <TableHeader className="[&_th]:h-8 [&_th]:text-xs [&_th]:font-normal [&_th]:text-ink-subtle">
                      <TableRow>
                        <TableHead className={`pl-0 ${PINNED}`}>Host</TableHead>
                        <TableHead>Last seen</TableHead>
                        <TableHead className="text-right">CPU busy</TableHead>
                        <TableHead className="text-right">Memory used</TableHead>
                        <TableHead className="text-right">Fullest filesystem</TableHead>
                        <TableHead className="text-right">Load (1 min)</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.hosts.map((host) => (
                        <TableRow key={host.host} {...clickableRow()}>
                          <TableCell className={`max-w-xs pl-0 max-sm:max-w-40 ${PINNED}`}>
                            <TruncatedText
                              text={host.host}
                              className="font-mono text-xs text-link hover:underline"
                              render={
                                <Link
                                  to="/projects/$projectId/hosts/$host"
                                  params={{ projectId, host: host.host }}
                                  search={{
                                    ...rangeSearch(range),
                                    ...environmentSearch(environment),
                                  }}
                                  {...ROW_LINK}
                                />
                              }
                            />
                          </TableCell>
                          <TableCell>
                            <span className="flex flex-wrap items-center gap-2">
                              <time dateTime={host.lastSeen} className="whitespace-nowrap">
                                {formatPreciseMoment(host.lastSeen, data.timeZone)}
                              </time>
                              <Freshness stale={host.stale} />
                            </span>
                          </TableCell>
                          <ShareCell percent={host.cpuPercent} />
                          <ShareCell percent={host.memoryPercent} />
                          <ShareCell
                            percent={host.filesystemPercent}
                            detail={host.filesystemMount}
                          />
                          <ValueCell text={formatLoad(host.load1m)} />
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollHint>
                <p className="max-w-4xl text-xs text-pretty text-ink-subtle">
                  Each value is the host's latest in the period. The bar beside a share shows it out
                  of 100%; at {HIGH_PERCENT}% or more it is marked High. Stale means no data arrived
                  in the last 5 minutes. This status appears when the period extends to now. A dash
                  means the host sent no data to calculate the value. Read-only filesystems, such as
                  snap package images, are always full. They are excluded from the fullest
                  filesystem value.
                </p>
                {data.truncated && (
                  <p className="text-sm text-ink-subtle">
                    More than {formatWhole(data.hosts.length)} hosts sent metrics: these are the
                    first by name.
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
