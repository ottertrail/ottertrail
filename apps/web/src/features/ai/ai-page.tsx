import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, OctagonAlertIcon, SparklesIcon } from "lucide-react";

import { ButtonAnchor } from "@/components/button-anchor";
import { ButtonLink } from "@/components/button-link";
import { type Stat, StatStrip } from "@/components/stat-strip";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { WhenAllowed } from "@/components/when-allowed";
import { type AiFilters, type AiReport, aiReportQuery } from "@/lib/ai-api";
import { DEFAULT_ENVIRONMENT, type PageRange } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import { AI_DOCS_URL } from "@/lib/docs";
import { MISSING } from "@/lib/missing";

import {
  formatConversion,
  formatCount,
  formatDay,
  formatDayRange,
  formatTimeOfDay,
  formatWhole,
  pointsChange,
  relativeChange,
} from "../analytics/format";
import { ReportFilterBar } from "../errors/range-controls";
import { NoSuchProject } from "../projects/no-such-project";
import { ChoiceFilter } from "../telemetry/filters";
import { aiSearchOf } from "../telemetry/search";
import { AiTrend } from "./ai-chart";
import { type AiPlace, FailuresTable, FiguresTable, RecentCalls, UsersTable } from "./ai-tables";
import { featureLabel, formatMs, formatTokens, formatUsd, MIN_CALLS_FOR_CHANGE } from "./format";

/** A filter's choices: the values the period offers, each with its label. */
const choices = (values: readonly string[] | undefined, label = (value: string) => value) =>
  (values ?? []).map((value) => ({ value, label: label(value) }));

const hasFilters = (filters: AiFilters) =>
  Object.values(filters).some((value) => value !== undefined);

/** "Changes compare with 3 to 9 Nov 2026, up to 15:00 on 9 Nov." */
function comparisonNote({ previous, timeZone }: AiReport): string {
  const days = formatDayRange(previous.firstDay, previous.lastDay);
  if (previous.totals.calls === 0) return `No calls in ${days} to compare with.`;
  if (previous.until === null) return `Changes compare with ${days}.`;
  const time = formatTimeOfDay(previous.until, timeZone);
  return previous.firstDay === previous.lastDay
    ? `Changes compare with ${days}, up to ${time}.`
    : `Changes compare with ${days}, up to ${time} on ${formatDay(previous.lastDay)}.`;
}

/**
 * The period's figures in one strip, each against the period before; a
 * change shows only once the calls it rests on reach the minimum. The
 * cost is always named an estimate, and the calls it leaves out are
 * counted under it.
 */
function Summary({ report }: { report: AiReport }) {
  const { totals } = report;
  const before = report.previous.totals;
  const calls = { current: totals.calls, previous: before.calls };
  const stats: Stat[] = [
    {
      label: "Estimated cost (USD)",
      value: formatUsd(totals.costUsd),
      change: relativeChange(totals.costUsd, before.costUsd),
      before: formatUsd(before.costUsd),
      counts: calls,
    },
    {
      label: "Calls",
      value: formatCount(totals.calls),
      change: relativeChange(totals.calls, before.calls),
      before: formatWhole(before.calls),
      counts: calls,
    },
    {
      label: "Input tokens",
      value: formatTokens(totals.inputTokens),
      change: relativeChange(totals.inputTokens, before.inputTokens),
      before: formatWhole(before.inputTokens),
      counts: calls,
    },
    {
      label: "Output tokens",
      value: formatTokens(totals.outputTokens),
      change: relativeChange(totals.outputTokens, before.outputTokens),
      before: formatWhole(before.outputTokens),
      counts: calls,
    },
    {
      label: "Cache-read share",
      value: formatPercentOrDash(totals.cacheReadShare),
      change: pointsChange(totals.cacheReadShare, before.cacheReadShare),
      before: formatPercentOrDash(before.cacheReadShare),
      counts: calls,
    },
    {
      label: "95th percentile",
      value: formatMs(totals.p95Ms),
      change: relativeChange(totals.p95Ms, before.p95Ms),
      before: formatMs(before.p95Ms),
      counts: calls,
    },
    {
      label: "Failed",
      value: formatPercentOrDash(totals.failedShare),
      change: pointsChange(totals.failedShare, before.failedShare),
      before: formatPercentOrDash(before.failedShare),
      counts: calls,
    },
  ];
  const unpriced = totals.noPriceCalls;
  return (
    <section aria-label="Summary" className="flex flex-col gap-3">
      <StatStrip label="Figures" stats={stats} minCount={MIN_CALLS_FOR_CHANGE} />
      {unpriced > 0 && (
        <p className="max-w-4xl text-sm text-pretty text-ink">
          {formatWhole(unpriced)} {unpriced === 1 ? "call" : "calls"} had no price and{" "}
          {unpriced === 1 ? "is" : "are"} not in the cost
          {totals.noPriceModels.length > 0 && `: ${totals.noPriceModels.join(", ")}`}.
          <WhenAllowed permission="projects">
            {" "}
            <Link
              to="/settings"
              search={{ tab: "ai-models", show: "no-price" }}
              className="text-link hover:underline"
            >
              Set prices in Settings
            </Link>
            .
          </WhenAllowed>
        </p>
      )}
      <p className="max-w-4xl text-xs text-pretty text-ink-subtle">
        Cost is an estimate from token counts and model prices. {comparisonNote(report)}
      </p>
    </section>
  );
}

/** A share as a percentage, one decimal under 10%; "–" with nothing to divide. */
function formatPercentOrDash(value: number | null): string {
  return value === null ? MISSING : formatConversion(value);
}

/** While the project has never sent an AI call: what the page needs, and where to read how. */
function NoCallsYet({ projectId }: { projectId: string }) {
  return (
    <Empty className="border border-dashed p-10">
      <EmptyHeader className="max-w-xl">
        <EmptyMedia variant="icon">
          <SparklesIcon />
        </EmptyMedia>
        <EmptyTitle>No AI calls yet</EmptyTitle>
        <EmptyDescription>
          This page reads the LLM calls in your server&apos;s traces. Send traces over OpenTelemetry
          with a GenAI instrumentation for your model SDK, or send each call from your server over
          HTTP, and each call shows here with its tokens, cost, and latency.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row flex-wrap justify-center">
        <ButtonAnchor
          variant="outline"
          href={AI_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          How to send AI calls
          <ArrowUpRightIcon aria-hidden="true" />
          <span className="sr-only">(opens in a new tab)</span>
        </ButtonAnchor>
        <WhenAllowed permission="projects">
          <ButtonLink
            variant="outline"
            to="/projects/$projectId/settings"
            params={{ projectId }}
            search={{ tab: "server" }}
          >
            Project settings
          </ButtonLink>
        </WhenAllowed>
      </EmptyContent>
    </Empty>
  );
}

/**
 * The LLM calls in the project's traces (docs/ai-usage.md): estimated
 * cost, tokens, latency, and failures over the period, a chart split by
 * model or feature, and tables by model, feature, user, and failure, then
 * the latest calls. Every filter is in the address; a model or feature in
 * a table filters by it.
 */
export function AiPage({
  projectId,
  range,
  environment = DEFAULT_ENVIRONMENT,
  filters,
}: {
  projectId: string;
  range: PageRange;
  environment?: string;
  filters: AiFilters;
}) {
  const navigate = useNavigate();
  const report = useQuery(aiReportQuery(projectId, range, environment, filters));
  const show = (next: { range?: PageRange; environment?: string; filters?: AiFilters }) =>
    void navigate({
      to: "/projects/$projectId/ai",
      params: { projectId },
      search: aiSearchOf({
        range: next.range ?? range,
        environment: next.environment ?? environment,
        filters: next.filters ?? filters,
      }),
    });
  const filter = (changes: AiFilters) => show({ filters: { ...filters, ...changes } });

  if (report.error instanceof ApiError && report.error.status === 404) {
    return <NoSuchProject />;
  }
  const data = report.data;
  const options = data?.filterOptions;
  const place: AiPlace = { projectId, range, environment, filters };

  return (
    <div className="flex flex-col">
      <ReportFilterBar
        label="Period, environment, and filters"
        range={range}
        environment={environment}
        answered={data}
        onRange={(next) => show({ range: next })}
        onEnvironment={(next) => show({ environment: next })}
        filters={
          data?.received !== false && (
            <>
              <ChoiceFilter
                label="Service"
                anyLabel="Any service"
                choices={choices(options?.services)}
                value={filters.service}
                onChange={(service) => filter({ service })}
                className="w-36"
              />
              <ChoiceFilter
                label="Provider"
                anyLabel="Any provider"
                choices={choices(options?.providers)}
                value={filters.provider}
                onChange={(provider) => filter({ provider })}
                className="w-36"
              />
              <ChoiceFilter
                label="Model"
                anyLabel="Any model"
                choices={choices(options?.models)}
                value={filters.model}
                onChange={(model) => filter({ model })}
                className="w-44"
              />
              <ChoiceFilter
                label="Feature"
                anyLabel="Any feature"
                choices={choices(options?.features, featureLabel)}
                value={filters.feature}
                onChange={(feature) => filter({ feature })}
                className="w-40"
              />
            </>
          )
        }
      />
      <div className="flex flex-col gap-6 px-gutter py-5">
        {report.isError && (
          <Alert variant="destructive">
            <OctagonAlertIcon />
            <AlertTitle>
              {data === undefined
                ? "The AI report could not load"
                : "The AI report could not refresh"}
            </AlertTitle>
            <AlertDescription>
              {report.error.message}
              {data !== undefined && " The figures below are from the last successful load."}
            </AlertDescription>
            <AlertAction>
              <Button variant="outline" size="sm" onClick={() => void report.refetch()}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        )}
        {data === undefined ? (
          !report.isError && (
            <div
              className="flex flex-col gap-4"
              aria-busy="true"
              aria-label="Loading the AI report"
            >
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-7">
                {Array.from({ length: 7 }, (_, index) => (
                  <div key={index} className="flex flex-col gap-2">
                    <Skeleton className="h-3 w-20" />
                    <Skeleton className="h-7 w-16" />
                  </div>
                ))}
              </div>
              <Skeleton className="h-[180px] w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          )
        ) : !data.received ? (
          <NoCallsYet projectId={projectId} />
        ) : data.totals.calls === 0 ? (
          <Empty className="border border-dashed p-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SparklesIcon />
              </EmptyMedia>
              <EmptyTitle>No AI calls in this period</EmptyTitle>
              <EmptyDescription>
                {hasFilters(filters)
                  ? "No call matches these filters. Clear a filter or choose a longer period."
                  : `No call arrived${environment === DEFAULT_ENVIRONMENT ? "" : ` in ${environment}`} in this period. Choose a longer period.`}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div
            className="flex flex-col gap-6 transition-opacity data-[stale=true]:opacity-60"
            data-stale={report.isPlaceholderData}
            aria-busy={report.isPlaceholderData}
          >
            <Summary report={data} />
            <AiTrend
              projectId={projectId}
              range={range}
              environment={environment}
              filters={filters}
            />
            <FiguresTable
              title="By model"
              place={place}
              kind="model"
              rows={data.models}
              empty="No call in this period."
            />
            <FiguresTable
              title="By feature"
              place={place}
              kind="feature"
              rows={data.features}
              empty="No call in this period."
            />
            {/* Side by side by the content's width, not the window's. */}
            <div className="@container border-t pt-5">
              <div className="grid gap-8 @5xl:grid-cols-2">
                <UsersTable place={place} report={data} />
                <FailuresTable report={data} />
              </div>
            </div>
            <RecentCalls place={place} />
          </div>
        )}
      </div>
    </div>
  );
}
