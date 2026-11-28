import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUpRightIcon } from "lucide-react";
import { Area, AreaChart, Bar, BarChart, ReferenceLine, XAxis, YAxis } from "recharts";

import { BreakdownTable } from "@/components/breakdown-table";
import { ButtonLink } from "@/components/button-link";
import { ChangedValue } from "@/components/changed-value";
import { PINNED } from "@/components/pinned-column";
import { ScrollHint } from "@/components/scroll-hint";
import { type Stat, StatStrip } from "@/components/stat-strip";
import { StatusBadge } from "@/components/status-badge";
import { TruncatedText } from "@/components/truncated-text";
import { Badge } from "@/components/ui/badge";
import { ChartContainer } from "@/components/ui/chart";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatUsd, MIN_CALLS_FOR_CHANGE } from "@/features/ai/format";
import {
  formatConversion,
  formatCount,
  formatDay,
  formatPercent,
  formatTimeOfDay,
  formatWhole,
  pointsChange,
  relativeChange,
} from "@/features/analytics/format";
import { LiveDot } from "@/features/analytics/now-indicator";
import { deviceLabel, formatVital, type Rating, rate } from "@/features/speed/format";
import { RatingBadge } from "@/features/speed/rating";
import { formatDuration } from "@/features/telemetry/format";
import { environmentSearch } from "@/features/telemetry/search";
import { CAUSE_TEXT, formatMoment, formatMs, formatUptime } from "@/features/uptime/format";
import { useAccess } from "@/lib/access";
import { DEFAULT_PERIOD } from "@/lib/analytics-api";
import { AI_DOCS_URL } from "@/lib/docs";
import { goalStepText } from "@/lib/goals-api";
import { MISSING } from "@/lib/missing";
import { type NowMinute, nowQuery } from "@/lib/now-api";
import {
  type OverviewGoal,
  type Retained,
  type OverviewPeriod,
  type PeriodWidgetId,
  widgetQuery,
  widgetTitle,
} from "@/lib/overview-api";

import {
  MIN_ERRORS_FOR_CHANGE,
  MIN_LOADS_FOR_CHANGE,
  MIN_LOADS_TO_RATE,
  periodPhrase,
  shortUrl,
} from "./format";
import { type Arrange, WidgetEmpty, WidgetFrame, WidgetNote, WidgetState } from "./widget-frame";

export interface WidgetProps {
  projectId: string;
  period: OverviewPeriod;
  environment: string;
  arrange?: Arrange | undefined;
}

const headLink = "text-sm whitespace-nowrap text-link hover:underline";

const headClass = "h-8 text-xs font-normal text-ink-subtle";
const numHeadClass = `${headClass} text-right`;
const numClass = "text-right tabular-nums";

function useWidget<K extends PeriodWidgetId>(id: K, props: WidgetProps) {
  return useQuery({
    ...widgetQuery(props.projectId, id, props.period, props.environment),
    enabled: props.arrange?.hidden !== true,
  });
}

function formatSince(iso: string, timeZone: string): string {
  const day = (moment: Date) =>
    new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short" }).format(moment);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
  return day(new Date(iso)) === day(new Date())
    ? `${time} today`
    : `${day(new Date(iso))}, ${time}`;
}

export function AttentionWidget(props: WidgetProps) {
  const query = useWidget("attention", props);
  const { canUse } = useAccess();
  const { projectId } = props;
  const title = widgetTitle("attention");
  return (
    <WidgetFrame
      id="attention"
      title={title}
      arrange={props.arrange}
      link={
        <Link to="/projects/$projectId/alerts" params={{ projectId }} className={headLink}>
          Alerts
        </Link>
      }
    >
      <WidgetState title={title} query={query}>
        {(data) => {
          const rows = [
            ...data.alerts.map((alert) => ({
              key: `alert-${alert.ruleId}-${alert.subjectName}`,
              state: <StatusBadge tone="critical">Firing</StatusBadge>,
              what: alert.ruleName,
              detail: alert.subjectName,
              cause: alert.message,
              since: formatSince(alert.since, data.timeZone),
            })),
            ...data.down.map((check) => ({
              key: `down-${check.checkId}`,
              state: <StatusBadge tone="critical">Down</StatusBadge>,
              what: check.name,
              detail: shortUrl(check.url),
              cause:
                check.cause === "status" && check.statusCode !== null
                  ? `Answered ${check.statusCode}`
                  : check.cause === null
                    ? MISSING
                    : CAUSE_TEXT[check.cause],
              since: check.since === null ? MISSING : formatSince(check.since, data.timeZone),
            })),
            ...data.certificates.map((check) => ({
              key: `certificate-${check.checkId}`,
              state: check.expired ? (
                <StatusBadge tone="critical">Expired</StatusBadge>
              ) : (
                <StatusBadge tone="warning">Expiring</StatusBadge>
              ),
              what: check.name,
              detail: shortUrl(check.url),
              cause: `Its certificate ${check.expired ? "expired" : "expires"} on ${formatMoment(check.expiresAt, data.timeZone)}`,
              since: MISSING,
            })),
          ];
          const active = data.checks.total - data.checks.paused;
          if (data.checks.total === 0 && data.rules === 0) {
            const manage = canUse("uptime_alerts", "manage");
            return (
              <WidgetEmpty
                title="No checks or alert rules yet"
                action={
                  manage ? (
                    <div className="flex flex-wrap gap-2">
                      <ButtonLink
                        variant="outline"
                        size="sm"
                        to="/projects/$projectId/uptime"
                        params={{ projectId }}
                      >
                        Add check
                      </ButtonLink>
                      <ButtonLink
                        variant="outline"
                        size="sm"
                        to="/projects/$projectId/alerts"
                        params={{ projectId }}
                      >
                        Add rule
                      </ButtonLink>
                    </div>
                  ) : undefined
                }
              >
                Add a check or alert rule to start monitoring.
              </WidgetEmpty>
            );
          }
          if (rows.length === 0) {
            return (
              <p className="flex flex-wrap items-center gap-2 text-sm text-ink">
                <StatusBadge tone="good">Clear</StatusBadge>
                {active === 0
                  ? "Nothing firing."
                  : `Nothing firing; ${active} ${active === 1 ? "check" : "checks"} up.`}
              </p>
            );
          }
          return (
            <div className="flex flex-col gap-2">
              <Table className="table-fixed max-sm:block">
                <caption className="sr-only">What is wrong now</caption>
                <TableHeader className="max-sm:sr-only">
                  <TableRow className="hover:bg-transparent">
                    <TableHead scope="col" className={`${headClass} w-1/4 pl-0`}>
                      What
                    </TableHead>
                    <TableHead scope="col" className={headClass}>
                      Cause
                    </TableHead>
                    <TableHead scope="col" className={`${headClass} w-28 pr-0 text-right`}>
                      Since
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className="max-sm:block">
                  {rows.map((row) => (
                    <TableRow
                      key={row.key}
                      className="hover:bg-transparent max-sm:flex max-sm:flex-col max-sm:items-start max-sm:gap-1 max-sm:py-2"
                    >
                      <TableCell className="py-1.5 pl-0 align-top whitespace-normal text-ink max-sm:p-0">
                        <span className="mb-1 block">{row.state}</span>
                        {row.what}
                        <TruncatedText text={row.detail} className="text-xs text-ink-subtle" />
                      </TableCell>
                      <TableCell className="py-1.5 align-top break-words whitespace-normal text-ink-muted max-sm:p-0">
                        {row.cause}
                      </TableCell>
                      <TableCell className="py-1.5 pr-0 text-right align-top whitespace-normal tabular-nums max-sm:p-0 max-sm:text-left max-sm:text-ink-subtle">
                        <span className="sm:hidden">Since </span>
                        {row.since}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {data.checks.total > 0 && (
                <WidgetNote>
                  {data.checks.up} of {active} {active === 1 ? "check" : "checks"} up.
                </WidgetNote>
              )}
            </div>
          );
        }}
      </WidgetState>
    </WidgetFrame>
  );
}

export function ErrorsWidget(props: WidgetProps) {
  const query = useWidget("errors", props);
  const { projectId, period } = props;
  const title = widgetTitle("errors");
  return (
    <WidgetFrame
      id="errors"
      title={title}
      arrange={props.arrange}
      link={
        <Link to="/projects/$projectId/errors" params={{ projectId }} className={headLink}>
          Errors
        </Link>
      }
    >
      <WidgetState title={title} query={query}>
        {(data) => {
          if (!data.received) {
            return (
              <WidgetEmpty
                title="No errors recorded"
                action={
                  <Link
                    to="/projects/$projectId/errors"
                    params={{ projectId }}
                    className={headLink}
                  >
                    Errors
                  </Link>
                }
              >
                The tracker reports browser errors by itself. Servers report theirs through
                OpenTelemetry.
              </WidgetEmpty>
            );
          }
          const stats: Stat[] = [
            {
              label: "Occurrences",
              value: formatCount(data.occurrences),
              change: relativeChange(data.occurrences, data.previousOccurrences),
              before: formatWhole(data.previousOccurrences),
              counts: { current: data.occurrences, previous: data.previousOccurrences },
            },
            { label: "New", value: formatWhole(data.newGroups) },
            // Counted in the 1,000 most recent groups: more when the list was cut.
            {
              label: "Regressed",
              value: `${formatWhole(data.regressedGroups)}${data.truncated ? "+" : ""}`,
            },
          ];
          return (
            <div className="flex flex-col gap-3">
              <StatStrip
                label="Errors"
                stats={stats}
                minCount={MIN_ERRORS_FOR_CHANGE}
                className="lg:grid-cols-3"
              />
              {data.top.length === 0 ? (
                <p className="text-sm text-ink-subtle">
                  No unresolved errors in {periodPhrase(period)}.
                </p>
              ) : (
                <ScrollHint>
                  <Table className="table-fixed max-sm:min-w-[28rem]">
                    <caption className="sr-only">Unresolved errors, most users first</caption>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead scope="col" className={`${headClass} ${PINNED} w-1/2 pl-0`}>
                          Unresolved, most users first
                        </TableHead>
                        <TableHead scope="col" className={numHeadClass}>
                          Users
                        </TableHead>
                        <TableHead scope="col" className={numHeadClass}>
                          Visitors
                        </TableHead>
                        <TableHead scope="col" className={`${numHeadClass} pr-0`}>
                          Occurrences
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.top.map((group) => (
                        <TableRow key={group.fingerprint} className="hover:bg-transparent">
                          <TableCell className={`${PINNED} py-1.5 pl-0`}>
                            <div className="flex min-w-0 items-center gap-2">
                              {group.status === "regressed" && (
                                <StatusBadge tone="critical">Regressed</StatusBadge>
                              )}
                              {group.isNew && <Badge variant="outline">New</Badge>}
                              <TruncatedText
                                text={`${group.type}: ${group.message}`}
                                className="text-link hover:underline"
                                render={
                                  <Link
                                    to="/projects/$projectId/errors/$fingerprint"
                                    params={{ projectId, fingerprint: group.fingerprint }}
                                  />
                                }
                              />
                            </div>
                          </TableCell>
                          <TableCell className={`py-1.5 ${numClass}`}>
                            {formatWhole(group.users)}
                          </TableCell>
                          <TableCell className={`py-1.5 ${numClass}`}>
                            {formatWhole(group.visitors)}
                          </TableCell>
                          <TableCell className={`py-1.5 pr-0 ${numClass}`}>
                            {formatWhole(group.occurrences)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollHint>
              )}
              {data.truncated && (
                <WidgetNote>
                  Counted from the 1,000 most recent error groups. Choose a shorter period for every
                  group.
                </WidgetNote>
              )}
            </div>
          );
        }}
      </WidgetState>
    </WidgetFrame>
  );
}

export function UptimeWidget(props: WidgetProps) {
  const query = useWidget("uptime", props);
  const { canUse } = useAccess();
  const { projectId, period } = props;
  const title = widgetTitle("uptime");
  const periodLabel = period === "today" ? "today" : period === "7d" ? "7 days" : "30 days";
  return (
    <WidgetFrame
      id="uptime"
      title={title}
      arrange={props.arrange}
      link={
        <Link to="/projects/$projectId/uptime" params={{ projectId }} className={headLink}>
          Uptime
        </Link>
      }
    >
      <WidgetState title={title} query={query}>
        {(data) =>
          data.checks.length === 0 ? (
            <WidgetEmpty
              title="No uptime checks"
              action={
                canUse("uptime_alerts", "manage") ? (
                  <ButtonLink
                    variant="outline"
                    size="sm"
                    to="/projects/$projectId/uptime"
                    params={{ projectId }}
                  >
                    Add check
                  </ButtonLink>
                ) : undefined
              }
            >
              Add a URL to check its availability.
            </WidgetEmpty>
          ) : (
            <div className="flex flex-col gap-2">
              <ScrollHint>
                <Table className="table-fixed max-sm:min-w-[34rem]">
                  <caption className="sr-only">Each uptime check</caption>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead scope="col" className={`${headClass} ${PINNED} pl-0`}>
                        Check
                      </TableHead>
                      <TableHead scope="col" className={`${headClass} w-20`}>
                        State
                      </TableHead>
                      <TableHead scope="col" className={`${numHeadClass} w-28`}>
                        Uptime, {periodLabel}
                      </TableHead>
                      <TableHead scope="col" className={`${numHeadClass} w-20`}>
                        Incidents
                      </TableHead>
                      <TableHead scope="col" className={`${numHeadClass} w-28 pr-0`}>
                        Last response
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.checks.map((check) => (
                      <TableRow key={check.id} className="hover:bg-transparent">
                        <TableCell className={`${PINNED} py-1.5 pl-0`}>
                          <TruncatedText
                            text={check.name}
                            className="text-link hover:underline"
                            render={
                              <Link
                                to="/projects/$projectId/uptime/$checkId"
                                params={{ projectId, checkId: check.id }}
                              />
                            }
                          />
                          <TruncatedText
                            text={shortUrl(check.url)}
                            className="max-w-full text-xs text-ink-subtle"
                          />
                        </TableCell>
                        <TableCell className="py-1.5">
                          {check.paused ? (
                            <StatusBadge tone="neutral">Paused</StatusBadge>
                          ) : check.state === "up" ? (
                            <StatusBadge tone="good">Up</StatusBadge>
                          ) : check.state === "down" ? (
                            <StatusBadge tone="critical">Down</StatusBadge>
                          ) : (
                            <StatusBadge tone="neutral">Pending</StatusBadge>
                          )}
                        </TableCell>
                        <TableCell className={`py-1.5 ${numClass}`}>
                          {formatUptime(check.uptime)}
                        </TableCell>
                        <TableCell className={`py-1.5 ${numClass}`}>
                          {formatWhole(check.incidents)}
                        </TableCell>
                        <TableCell className={`py-1.5 pr-0 ${numClass}`}>
                          {check.lastResponseMs === null ? MISSING : formatMs(check.lastResponseMs)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollHint>
              <WidgetNote>
                No uptime target is set: every incident counts. Uptime is cut, not rounded, so a
                check that was down at all never reads 100%.
              </WidgetNote>
            </div>
          )
        }
      </WidgetState>
    </WidgetFrame>
  );
}

const failedShare = (failed: number, requests: number) =>
  requests === 0 ? null : failed / requests;

export function ServicesWidget(props: WidgetProps) {
  const query = useWidget("services", props);
  const { projectId, period } = props;
  const title = widgetTitle("services");
  return (
    <WidgetFrame
      id="services"
      title={title}
      arrange={props.arrange}
      link={
        <Link to="/projects/$projectId/services" params={{ projectId }} className={headLink}>
          Services
        </Link>
      }
    >
      <WidgetState title={title} query={query}>
        {(data) => {
          if (!data.received) {
            return (
              <WidgetEmpty
                title="No traces received"
                action={
                  <Link
                    to="/projects/$projectId/services"
                    params={{ projectId }}
                    className={headLink}
                  >
                    Services
                  </Link>
                }
              >
                Send OpenTelemetry traces to see your services' requests and latency.
              </WidgetEmpty>
            );
          }
          if (data.services.length === 0) {
            return (
              <p className="text-sm text-ink-subtle">
                No server requests in {periodPhrase(period)}.
              </p>
            );
          }
          return (
            <div className="flex flex-col gap-2">
              <ScrollHint>
                <Table className="max-sm:min-w-[26rem]">
                  <caption className="sr-only">Each service's requests, busiest first</caption>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead scope="col" className={`${headClass} ${PINNED} pl-0`}>
                        Service, busiest first
                      </TableHead>
                      <TableHead scope="col" className={numHeadClass}>
                        Requests
                      </TableHead>
                      <TableHead scope="col" className={numHeadClass}>
                        Failed
                      </TableHead>
                      <TableHead scope="col" className={`${numHeadClass} pr-0`}>
                        p95
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.services.map((item) => {
                      const counts = { current: item.requests, previous: item.previous.requests };
                      return (
                        <TableRow key={item.service} className="align-top hover:bg-transparent">
                          <TableCell className={`${PINNED} py-1.5 pl-0`}>
                            <Link
                              to="/projects/$projectId/services/$service"
                              params={{ projectId, service: item.service }}
                              className="font-mono text-link hover:underline"
                            >
                              {item.service}
                            </Link>
                          </TableCell>
                          <TableCell className={`py-1.5 ${numClass}`}>
                            <ChangedValue
                              value={formatWhole(item.requests)}
                              change={relativeChange(item.requests, item.previous.requests)}
                              counts={counts}
                              min={MIN_LOADS_FOR_CHANGE}
                            />
                          </TableCell>
                          <TableCell className={`py-1.5 ${numClass}`}>
                            <ChangedValue
                              value={formatPercent(failedShare(item.failed, item.requests))}
                              change={pointsChange(
                                failedShare(item.failed, item.requests),
                                failedShare(item.previous.failed, item.previous.requests),
                              )}
                              counts={counts}
                              min={MIN_LOADS_FOR_CHANGE}
                            />
                          </TableCell>
                          <TableCell className={`py-1.5 pr-0 ${numClass}`}>
                            <ChangedValue
                              value={item.p95Us === null ? MISSING : formatDuration(item.p95Us)}
                              change={relativeChange(item.p95Us, item.previous.p95Us)}
                              counts={counts}
                              min={MIN_LOADS_FOR_CHANGE}
                            />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </ScrollHint>
              <WidgetNote>
                Changes compare with the previous period.
                {data.more ? " Quieter services are on the Services page." : ""}
              </WidgetNote>
            </div>
          );
        }}
      </WidgetState>
    </WidgetFrame>
  );
}

export function AiCostWidget(props: WidgetProps) {
  const query = useWidget("ai-cost", props);
  const { projectId, period, environment } = props;
  const title = widgetTitle("ai-cost");
  const aiSearch = {
    ...(period === DEFAULT_PERIOD ? {} : { period }),
    ...environmentSearch(environment),
  };
  return (
    <WidgetFrame
      id="ai-cost"
      title={title}
      arrange={props.arrange}
      link={
        <Link
          to="/projects/$projectId/ai"
          params={{ projectId }}
          search={aiSearch}
          className={headLink}
        >
          AI
        </Link>
      }
    >
      <WidgetState title={title} query={query}>
        {(data) => {
          if (!data.received) {
            return (
              <WidgetEmpty
                title="No AI calls yet"
                action={
                  <a
                    href={AI_DOCS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`${headLink} inline-flex items-center gap-0.5`}
                  >
                    How to send AI calls
                    <ArrowUpRightIcon aria-hidden="true" className="size-3.5" />
                    <span className="sr-only">(opens in a new tab)</span>
                  </a>
                }
              >
                Send traces with a GenAI instrumentation, or send calls over HTTP, to see what your
                AI calls cost.
              </WidgetEmpty>
            );
          }
          const counts = { current: data.calls, previous: data.previousCalls };
          const unpriced = data.noPriceCalls;
          return (
            <div className="flex flex-col gap-3">
              <StatStrip
                label="AI cost"
                stats={[
                  {
                    label: "Estimated cost (USD)",
                    value: formatUsd(data.costUsd),
                    change: relativeChange(data.costUsd, data.previousCostUsd),
                    before: formatUsd(data.previousCostUsd),
                    counts,
                  },
                  {
                    label: "Calls",
                    value: formatCount(data.calls),
                    change: relativeChange(data.calls, data.previousCalls),
                    before: formatWhole(data.previousCalls),
                    counts,
                  },
                ]}
                minCount={MIN_CALLS_FOR_CHANGE}
                className="lg:grid-cols-2"
              />
              {data.calls === 0 ? (
                <p className="text-sm text-ink-subtle">No AI calls in {periodPhrase(period)}.</p>
              ) : (
                data.models.length > 0 && (
                  <BreakdownTable
                    title="Models"
                    headingLevel={3}
                    caption="The models that cost the most, the costliest first"
                    nameHeading="Model"
                    figureHeadings={["Est. cost", "Calls"]}
                    rows={data.models.map((row) => ({
                      key: row.model,
                      title: row.model,
                      label: (
                        <Link
                          to="/projects/$projectId/ai"
                          params={{ projectId }}
                          search={{ ...aiSearch, model: row.model }}
                          className="hover:text-link hover:underline"
                        >
                          {row.model}
                        </Link>
                      ),
                      bar: row.costUsd,
                      figures: [formatUsd(row.costUsd), formatWhole(row.calls)],
                    }))}
                    empty=""
                    layout="stack"
                  />
                )
              )}
              <WidgetNote>
                Cost is an estimate from token counts and model prices.
                {unpriced > 0 &&
                  ` ${formatWhole(unpriced)} ${unpriced === 1 ? "call" : "calls"} had no price and ${unpriced === 1 ? "is" : "are"} not in it.`}
              </WidgetNote>
            </div>
          );
        }}
      </WidgetState>
    </WidgetFrame>
  );
}

const CORE = ["lcp", "inp", "cls"] as const;
const RANK: Record<Rating, number> = { good: 0, needsImprovement: 1, poor: 2 };

export function SpeedWidget(props: WidgetProps) {
  const query = useWidget("speed", props);
  const { projectId, period } = props;
  const title = widgetTitle("speed");
  return (
    <WidgetFrame
      id="speed"
      title={title}
      arrange={props.arrange}
      link={
        <Link to="/projects/$projectId/speed" params={{ projectId }} className={headLink}>
          Speed
        </Link>
      }
    >
      <WidgetState title={title} query={query}>
        {(data) => {
          if (!data.received) {
            return (
              <WidgetEmpty
                title="No page speed measured"
                action={
                  <Link to="/projects/$projectId/speed" params={{ projectId }} className={headLink}>
                    How to measure it
                  </Link>
                }
              >
                Check the tracker setup on the Speed page.
              </WidgetEmpty>
            );
          }
          if (data.devices.length === 0) {
            return (
              <p className="text-sm text-ink-subtle">
                No page loads measured in {periodPhrase(period)}.
              </p>
            );
          }
          return (
            <div className="flex flex-col gap-2">
              <ScrollHint>
                <Table className="max-sm:min-w-[32rem]">
                  <caption className="sr-only">
                    The 75th percentile of page loads on each kind of device
                  </caption>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead scope="col" className={`${headClass} ${PINNED} pl-0`}>
                        Device
                      </TableHead>
                      <TableHead scope="col" className={numHeadClass}>
                        LCP
                      </TableHead>
                      <TableHead scope="col" className={numHeadClass}>
                        INP
                      </TableHead>
                      <TableHead scope="col" className={numHeadClass}>
                        CLS
                      </TableHead>
                      <TableHead scope="col" className={headClass}>
                        Rating
                      </TableHead>
                      <TableHead scope="col" className={`${numHeadClass} pr-0`}>
                        Loads
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.devices.map((device) => {
                      const ratings = CORE.flatMap((name) => {
                        const value = device[name];
                        return value === null ? [] : [rate(name, value, data.thresholds[name])];
                      });
                      const worst =
                        ratings.length === 0
                          ? null
                          : ratings.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
                      const rated = device.loads >= MIN_LOADS_TO_RATE;
                      return (
                        <TableRow
                          key={device.deviceType ?? "unknown"}
                          className="hover:bg-transparent"
                        >
                          <TableCell className={`${PINNED} py-1.5 pl-0 text-ink`}>
                            {deviceLabel(device.deviceType)}
                          </TableCell>
                          {rated ? (
                            CORE.map((name) => (
                              <TableCell key={name} className={`py-1.5 ${numClass}`}>
                                {formatVital(name, device[name])}
                              </TableCell>
                            ))
                          ) : (
                            <TableCell colSpan={3} className="py-1.5 text-right text-ink-subtle">
                              Too few page loads to rate
                            </TableCell>
                          )}
                          <TableCell className="py-1.5">
                            {rated ? (
                              <RatingBadge rating={worst} />
                            ) : (
                              <StatusBadge tone="neutral">Not rated</StatusBadge>
                            )}
                          </TableCell>
                          <TableCell className={`py-1.5 pr-0 ${numClass}`}>
                            {formatWhole(device.loads)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </ScrollHint>
              <WidgetNote>
                The 75th percentile of page loads. Good at or under 2.5 s LCP, 200 ms INP and 0.1
                CLS; poor over 4 s, 500 ms and 0.25. A device's rating is the worst of the three,
                from {MIN_LOADS_TO_RATE} page loads.
              </WidgetNote>
            </div>
          );
        }}
      </WidgetState>
    </WidgetFrame>
  );
}

function goalStats(goal: OverviewGoal, visitors: number, previousVisitors: number): Stat[] {
  return [
    {
      label: `${goal.name}, visitors`,
      value: formatCount(goal.visitors),
      change: relativeChange(goal.visitors, goal.previous.visitors),
      before: formatWhole(goal.previous.visitors),
      counts: { current: goal.visitors, previous: goal.previous.visitors },
    },
    {
      label: "Conversion",
      value: formatConversion(goal.conversionRate),
      change: pointsChange(goal.conversionRate, goal.previous.conversionRate),
      before: formatConversion(goal.previous.conversionRate),
      counts: { current: visitors, previous: previousVisitors },
    },
    { label: "Times reached", value: formatCount(goal.events) },
  ];
}

export function MainGoalWidget(props: WidgetProps) {
  const query = useWidget("main-goal", props);
  const { can, canUse } = useAccess();
  const { projectId } = props;
  const title = widgetTitle("main-goal");
  const choose = can("projects") ? (
    <Link
      to="/projects/$projectId/settings"
      params={{ projectId }}
      search={{ tab: "general" }}
      className="text-link hover:underline"
    >
      Choose the main goal
    </Link>
  ) : null;
  return (
    <WidgetFrame id="main-goal" title={title} arrange={props.arrange}>
      <WidgetState title={title} query={query}>
        {(data) => {
          if (data.kind === "goal") {
            return (
              <div className="flex flex-col gap-3">
                <StatStrip
                  label="Main goal"
                  stats={goalStats(data.goal, data.visitors, data.previousVisitors)}
                  minCount={MIN_LOADS_FOR_CHANGE}
                  className="lg:grid-cols-3"
                />
                <WidgetNote>
                  {goalStepText(data.goal.step)}. Conversion is its visitors of all{" "}
                  {formatWhole(data.visitors)} visitors. {choose}
                </WidgetNote>
              </div>
            );
          }
          if (!data.received) {
            return (
              <WidgetEmpty
                title="No main goal, and no signed-in users yet"
                action={choose ?? undefined}
              >
                Choose a goal as the main one, or name signed-in users with data-user-id or
                identify() to count new ones here.
              </WidgetEmpty>
            );
          }
          return (
            <div className="flex flex-col gap-3">
              <StatStrip
                label="New signed-in users"
                stats={[
                  {
                    label: "New signed-in users",
                    value: formatCount(data.newUsers),
                    change: relativeChange(data.newUsers, data.previousNewUsers),
                    before: formatWhole(data.previousNewUsers),
                    counts: { current: data.newUsers, previous: data.previousNewUsers },
                  },
                ]}
                minCount={MIN_LOADS_FOR_CHANGE}
              />
              <WidgetNote>
                No main goal is set. Showing users first seen in this period. {choose}
                {choose === null && canUse("product_analytics", "view")
                  ? "An admin chooses the main goal."
                  : ""}
              </WidgetNote>
            </div>
          );
        }}
      </WidgetState>
    </WidgetFrame>
  );
}

const DAY_LINE = { visitors: { color: "var(--chart-1)" } };

function DayLine({ days }: { days: { day: string; visitors: number }[] }) {
  const first = days[0];
  const last = days.at(-1);
  const busiest = days.reduce(
    (a, b) => (b.visitors > a.visitors ? b : a),
    days[0] ?? { day: "", visitors: 0 },
  );
  if (first === undefined || last === undefined) return null;
  return (
    <figure className="flex flex-col gap-1">
      <ChartContainer config={DAY_LINE} aria-hidden="true" className="aspect-auto h-16 w-full">
        <AreaChart
          data={days}
          margin={{ top: 4, right: 1, bottom: 1, left: 1 }}
          accessibilityLayer={false}
        >
          <XAxis dataKey="day" hide />
          <YAxis hide domain={[0, (max: number) => Math.max(1, max)]} />
          <ReferenceLine y={0} stroke="var(--border)" />
          <Area
            dataKey="visitors"
            stroke="var(--chart-1)"
            strokeWidth={2}
            fill="var(--chart-1)"
            fillOpacity={0.15}
            isAnimationActive={false}
          />
        </AreaChart>
      </ChartContainer>
      <p className="sr-only">
        Visitors per day, from {formatWhole(first.visitors)} on {formatDay(first.day)} to{" "}
        {formatWhole(last.visitors)} on {formatDay(last.day)}; most, {formatWhole(busiest.visitors)}
        , on {formatDay(busiest.day)}.
      </p>
      <figcaption
        aria-hidden="true"
        className="flex justify-between text-xs text-ink-subtle tabular-nums"
      >
        <span>{formatDay(first.day, { weekday: true })}</span>
        <span>Visitors per day</span>
        <span>{formatDay(last.day, { weekday: true })}</span>
      </figcaption>
    </figure>
  );
}

const MINUTE_BARS = { visitors: { color: "var(--chart-1)" } };

/** Visitors per minute, small: the Right now view has the chart with its readout. */
function MinuteBars({ minutes, timeZone }: { minutes: NowMinute[]; timeZone: string }) {
  const first = minutes[0];
  const last = minutes.at(-1);
  if (first === undefined || last === undefined) return null;
  const busiest = minutes.reduce((a, b) => (b.visitors > a.visitors ? b : a), first);
  const time = (minute: NowMinute) => formatTimeOfDay(minute.start, timeZone);
  return (
    <figure className="flex flex-col gap-1">
      <ChartContainer config={MINUTE_BARS} aria-hidden="true" className="aspect-auto h-16 w-full">
        <BarChart
          data={minutes}
          margin={{ top: 4, right: 1, bottom: 1, left: 1 }}
          barCategoryGap={1}
          accessibilityLayer={false}
        >
          <XAxis dataKey="start" hide />
          <YAxis hide domain={[0, (max: number) => Math.max(1, max)]} />
          <ReferenceLine y={0} stroke="var(--border)" />
          <Bar
            dataKey="visitors"
            fill="var(--chart-1)"
            radius={[2, 2, 0, 0]}
            maxBarSize={24}
            isAnimationActive={false}
          />
        </BarChart>
      </ChartContainer>
      <p className="sr-only">
        Visitors per minute from {time(first)} to {time(last)}: most,{" "}
        {formatWhole(busiest.visitors)}, at {time(busiest)}; {formatWhole(last.visitors)} in the
        minute still running.
      </p>
      <figcaption
        aria-hidden="true"
        className="flex justify-between text-xs text-ink-subtle tabular-nums"
      >
        <span>{time(first)}</span>
        <span>Visitors per minute</span>
        <span>{time(last)}</span>
      </figcaption>
    </figure>
  );
}

/**
 * Live, whatever the overview's period: the Web analytics page's query,
 * polled every 15 seconds while the tab shows.
 */
export function NowWidget(props: WidgetProps) {
  const { projectId, environment } = props;
  const query = useQuery({
    ...nowQuery(projectId, environment),
    enabled: props.arrange?.hidden !== true,
  });
  const title = widgetTitle("now");
  return (
    <WidgetFrame
      id="now"
      title={title}
      arrange={props.arrange}
      link={
        <Link
          to="/projects/$projectId/web-analytics/now"
          params={{ projectId }}
          search={environmentSearch(environment)}
          className={headLink}
        >
          Pages and sources
        </Link>
      }
    >
      <WidgetState title={title} query={query}>
        {(data) => (
          <div className="flex flex-col gap-3">
            <StatStrip
              label={title}
              stats={[
                {
                  label: "Visitors now",
                  value: (
                    <span className="flex items-center gap-2">
                      <LiveDot live={data.visitors > 0} />
                      {formatWhole(data.visitors)}
                    </span>
                  ),
                },
                { label: "Last 30 minutes", value: formatWhole(data.windowVisitors) },
              ]}
              className="lg:grid-cols-2"
            />
            {data.windowVisitors === 0 ? (
              <p className="text-sm text-ink-subtle">Nobody in the last 30 minutes.</p>
            ) : (
              <MinuteBars minutes={data.perMinute} timeZone={data.timeZone} />
            )}
            <WidgetNote>Visitors now counts the last 5 minutes.</WidgetNote>
          </div>
        )}
      </WidgetState>
    </WidgetFrame>
  );
}

export function TrafficWidget(props: WidgetProps) {
  const query = useWidget("traffic", props);
  const { can } = useAccess();
  const { projectId, period } = props;
  const title = widgetTitle("traffic");
  return (
    <WidgetFrame
      id="traffic"
      title={title}
      arrange={props.arrange}
      link={
        <Link to="/projects/$projectId/web-analytics" params={{ projectId }} className={headLink}>
          Web analytics
        </Link>
      }
    >
      <WidgetState title={title} query={query}>
        {(data) => {
          if (!data.received) {
            return (
              <WidgetEmpty
                title="No pageviews yet"
                action={
                  can("projects") ? (
                    <ButtonLink
                      variant="outline"
                      size="sm"
                      to="/projects/$projectId/settings"
                      params={{ projectId }}
                    >
                      Install the snippet
                    </ButtonLink>
                  ) : undefined
                }
              >
                {can("projects")
                  ? "Install the tracking snippet on your site."
                  : "Ask an admin to install the tracking snippet."}
              </WidgetEmpty>
            );
          }
          const { summary, previousSummary: before } = data;
          const stat = (label: string, key: "visitors" | "visits" | "pageviews"): Stat => ({
            label,
            value: formatCount(summary[key]),
            change: relativeChange(summary[key], before[key]),
            before: formatWhole(before[key]),
            counts: { current: summary[key], previous: before[key] },
          });
          return (
            <div className="flex flex-col gap-3">
              <StatStrip
                label="Traffic"
                stats={[
                  stat("Visitors", "visitors"),
                  stat("Visits", "visits"),
                  stat("Pageviews", "pageviews"),
                ]}
                minCount={MIN_LOADS_FOR_CHANGE}
                className="lg:grid-cols-3"
              />
              {summary.pageviews === 0 ? (
                <p className="text-sm text-ink-subtle">No pageviews in {periodPhrase(period)}.</p>
              ) : (
                data.days.length > 1 && <DayLine days={data.days} />
              )}
              <WidgetNote>A person who visits on several days counts once for each day.</WidgetNote>
            </div>
          );
        }}
      </WidgetState>
    </WidgetFrame>
  );
}

export function GoalsWidget(props: WidgetProps) {
  const query = useWidget("goals", props);
  const { canUse } = useAccess();
  const { projectId } = props;
  const title = widgetTitle("goals");
  return (
    <WidgetFrame
      id="goals"
      title={title}
      arrange={props.arrange}
      link={
        <Link to="/projects/$projectId/product/events" params={{ projectId }} className={headLink}>
          Product analytics
        </Link>
      }
    >
      <WidgetState title={title} query={query}>
        {(data) =>
          data.goals.length === 0 ? (
            <WidgetEmpty
              title="No goals yet"
              action={
                canUse("product_analytics", "manage") && canUse("web_analytics") ? (
                  <ButtonLink
                    variant="outline"
                    size="sm"
                    to="/projects/$projectId/web-analytics"
                    params={{ projectId }}
                  >
                    Add goal
                  </ButtonLink>
                ) : undefined
              }
            >
              A goal counts a page viewed or an event, such as a signup.
            </WidgetEmpty>
          ) : (
            <ScrollHint>
              <Table className="max-sm:min-w-[26rem]">
                <caption className="sr-only">
                  Each goal's visitors, times reached and conversion
                </caption>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead scope="col" className={`${headClass} ${PINNED} pl-0`}>
                      Goal
                    </TableHead>
                    <TableHead scope="col" className={numHeadClass}>
                      Visitors
                    </TableHead>
                    <TableHead scope="col" className={numHeadClass}>
                      Times
                    </TableHead>
                    <TableHead scope="col" className={`${numHeadClass} pr-0`}>
                      Conversion
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.goals.map((goal) => (
                    <TableRow key={goal.id} className="align-top hover:bg-transparent">
                      <TableCell className={`${PINNED} py-1.5 pl-0 whitespace-normal text-ink`}>
                        {goal.name}{" "}
                        <span className="text-xs text-ink-subtle">{goalStepText(goal.step)}</span>
                        {goal.id === data.mainGoalId && (
                          <Badge variant="secondary" className="ml-1">
                            Main goal
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className={`py-1.5 ${numClass}`}>
                        <ChangedValue
                          value={formatWhole(goal.visitors)}
                          change={relativeChange(goal.visitors, goal.previous.visitors)}
                          counts={{ current: goal.visitors, previous: goal.previous.visitors }}
                          min={MIN_LOADS_FOR_CHANGE}
                        />
                      </TableCell>
                      <TableCell className={`py-1.5 ${numClass}`}>
                        {formatWhole(goal.events)}
                      </TableCell>
                      <TableCell className={`py-1.5 pr-0 ${numClass}`}>
                        <ChangedValue
                          value={formatConversion(goal.conversionRate)}
                          change={pointsChange(goal.conversionRate, goal.previous.conversionRate)}
                          counts={{ current: data.visitors, previous: data.previousVisitors }}
                          min={MIN_LOADS_FOR_CHANGE}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollHint>
          )
        }
      </WidgetState>
    </WidgetFrame>
  );
}

/** Mark incomplete weeks so partial retention is not read as final. */
const retained = (later: Retained | null, users: number) =>
  later === null
    ? "Not yet"
    : later.current
      ? "This week, not over"
      : users === 0
        ? MISSING
        : formatPercent(later.users / users);

const week1Share = (cohort: { week1: Retained | null; users: number }) =>
  (cohort.week1?.users ?? 0) / cohort.users;

export function UsersWidget(props: WidgetProps) {
  const query = useWidget("users", props);
  const { canUse } = useAccess();
  const { projectId } = props;
  const title = widgetTitle("users");
  const usersLink = canUse("users") ? (
    <Link to="/projects/$projectId/users" params={{ projectId }} className={headLink}>
      Users
    </Link>
  ) : (
    <Link to="/projects/$projectId/product/retention" params={{ projectId }} className={headLink}>
      Retention
    </Link>
  );
  return (
    <WidgetFrame id="users" title={title} arrange={props.arrange} link={usersLink}>
      <WidgetState title={title} query={query}>
        {(data) => {
          if (!data.received) {
            return (
              <WidgetEmpty title="No signed-in users yet">
                Signed-in users and their retention need your users' IDs. Name them with
                data-user-id or identify().
              </WidgetEmpty>
            );
          }
          // Only weeks that are over: a week in progress would always look low.
          const withWeek1 = data.cohorts.filter(
            (cohort) => cohort.week1 !== null && !cohort.week1.current && cohort.users > 0,
          );
          const latest = withWeek1.at(-1);
          const earlier = withWeek1.slice(0, -1);
          const average =
            earlier.length === 0
              ? null
              : earlier.reduce((total, cohort) => total + week1Share(cohort), 0) / earlier.length;
          const anyWeek4 = data.cohorts.some(
            (cohort) => cohort.week4 !== null && !cohort.week4.current,
          );
          return (
            <div className="flex flex-col gap-3">
              <StatStrip
                label="Signed-in users"
                stats={[
                  {
                    label: "Active",
                    value: formatCount(data.active),
                    change: relativeChange(data.active, data.previousActive),
                    before: formatWhole(data.previousActive),
                    counts: { current: data.active, previous: data.previousActive },
                  },
                  {
                    label: "New",
                    value: formatCount(data.new),
                    change: relativeChange(data.new, data.previousNew),
                    before: formatWhole(data.previousNew),
                    counts: { current: data.new, previous: data.previousNew },
                  },
                ]}
                minCount={MIN_LOADS_FOR_CHANGE}
                className="lg:grid-cols-2"
              />
              <ScrollHint>
                <Table className="max-sm:min-w-[22rem]">
                  <caption className="sr-only">
                    Weekly cohorts of signed-in users, and how many came back
                  </caption>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead scope="col" className={`${headClass} ${PINNED} pl-0`}>
                        Cohort, week of
                      </TableHead>
                      <TableHead scope="col" className={numHeadClass}>
                        Users
                      </TableHead>
                      <TableHead scope="col" className={numHeadClass}>
                        Week 1
                      </TableHead>
                      <TableHead scope="col" className={`${numHeadClass} pr-0`}>
                        Week 4
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.cohorts.toReversed().map((cohort) => (
                      <TableRow key={cohort.week} className="hover:bg-transparent">
                        <TableCell className={`${PINNED} py-1.5 pl-0 text-ink`}>
                          {formatDay(cohort.week)}
                        </TableCell>
                        <TableCell className={`py-1.5 ${numClass}`}>
                          {formatWhole(cohort.users)}
                        </TableCell>
                        <TableCell className={`py-1.5 ${numClass}`}>
                          {retained(cohort.week1, cohort.users)}
                        </TableCell>
                        <TableCell className={`py-1.5 pr-0 ${numClass}`}>
                          {retained(cohort.week4, cohort.users)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollHint>
              <WidgetNote>
                {latest === undefined
                  ? "No cohort's second week is over yet."
                  : `Week 1 of the ${formatDay(latest.week)} cohort: ${formatPercent(week1Share(latest))}${
                      average === null
                        ? "."
                        : `, against ${formatPercent(average)} for the earlier cohorts shown.`
                    }`}
                {anyWeek4 ? "" : " No cohort is four weeks old yet."} Active means any event while
                signed in.
              </WidgetNote>
              {data.newest !== null && data.newest.length > 0 && (
                <p className="text-sm text-ink-muted">
                  Newest:{" "}
                  {data.newest.map((user, index) => (
                    <span key={user.userId}>
                      {index > 0 && ", "}
                      <Link
                        to="/projects/$projectId/users/$userId"
                        params={{ projectId, userId: user.userId }}
                        className="text-link hover:underline"
                      >
                        {user.userId}
                      </Link>
                    </span>
                  ))}
                </p>
              )}
            </div>
          );
        }}
      </WidgetState>
    </WidgetFrame>
  );
}

export function SourcesWidget(props: WidgetProps) {
  const query = useWidget("sources", props);
  const { projectId, period } = props;
  const title = widgetTitle("sources");
  const empty = `No visits in ${periodPhrase(period)}.`;
  return (
    <WidgetFrame
      id="sources"
      title={title}
      arrange={props.arrange}
      link={
        <Link to="/projects/$projectId/web-analytics" params={{ projectId }} className={headLink}>
          Web analytics
        </Link>
      }
    >
      <WidgetState title={title} query={query}>
        {(data) => (
          <div className="grid gap-6 sm:grid-cols-2">
            <BreakdownTable
              title="Sources"
              headingLevel={3}
              caption="Where visitors came from, most visitors first"
              nameHeading="Source"
              figureHeadings={["Visitors"]}
              rows={data.sources.map((row) => ({
                key: row.value ?? "",
                label: row.value ?? "(unknown)",
                title: row.value ?? "(unknown)",
                bar: row.visitors,
                figures: [formatWhole(row.visitors)],
              }))}
              empty={empty}
              layout="stack"
            />
            <BreakdownTable
              title="Pages"
              headingLevel={3}
              caption="The pages with the most visitors"
              nameHeading="Page"
              figureHeadings={["Visitors"]}
              rows={data.pages.map((row) => ({
                key: row.path,
                label: row.path,
                title: row.path,
                bar: row.visitors,
                figures: [formatWhole(row.visitors)],
              }))}
              empty={empty}
              layout="stack"
            />
          </div>
        )}
      </WidgetState>
    </WidgetFrame>
  );
}
