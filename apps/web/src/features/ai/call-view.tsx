import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, OctagonAlertIcon, SearchXIcon } from "lucide-react";
import * as React from "react";

import { clickableRow, ROW_LINK } from "@/components/clickable-row";
import { Missing } from "@/components/missing";
import { PageTitle } from "@/components/page-header";
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
import { WhenAllowed } from "@/components/when-allowed";
import {
  type AiCallPrice,
  aiCallQuery,
  type AiConversationDetail,
  aiConversationQuery,
  type AiListedCall,
} from "@/lib/ai-calls-api";
import { ApiError } from "@/lib/api";

import { formatWhole } from "../analytics/format";
import { NoSuchProject } from "../projects/no-such-project";
import { formatPreciseMoment } from "../telemetry/format";
import { environmentSearch } from "../telemetry/search";
import { formatMoment } from "../users/format";
import { type AiCallsPlace, aiCallsSearchOf } from "./calls-search";
import { featureLabel, formatMs, formatTokens, formatUsd, isCutOff, modelLabel } from "./format";

/** What every cost on these pages is. */
export const COST_NOTE = "Cost is an estimate from token counts and model prices.";

/** A call's status: Failed with its error type, Cut off at its token limit, or OK. */
export function CallStatus({ call }: { call: AiListedCall }) {
  if (call.failed) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <StatusBadge tone="critical">Failed</StatusBadge>
        {call.errorType !== "" && (
          <TruncatedText text={call.errorType} className="min-w-0 text-xs text-ink-muted" />
        )}
      </span>
    );
  }
  if (isCutOff(call.finishReasons)) return <StatusBadge tone="warning">Cut off</StatusBadge>;
  return <span className="text-sm text-ink-subtle">OK</span>;
}

/** An estimated cost, or a dash named "No price" for a model without one. */
export function CallCost({ costUsd }: { costUsd: number | null }) {
  return costUsd === null ? <Missing label="No price" /> : <>{formatUsd(costUsd)}</>;
}

/** "22 Nov 2026" for a calendar day ("YYYY-MM-DD"). */
const formatCalendarDay = (day: string) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00Z`));

/** "22 Nov 2026" for a moment, in the instance's timezone. */
const formatDate = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone,
  }).format(new Date(iso));

const perMillion = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

/** Where a call's price comes from, in Settings → AI models' words. */
function priceSourceText(price: AiCallPrice, timeZone: string): string {
  if (price.source === "built_in") {
    return price.checked === null
      ? "Built-in price"
      : `Built-in price, checked ${formatCalendarDay(price.checked)}`;
  }
  if (price.source === "price_as") return `Price as ${price.model ?? "another model"}`;
  const on = price.model === null ? "" : ` on ${price.model}`;
  const from =
    price.effectiveFrom === null ? "" : ` from ${formatDate(price.effectiveFrom, timeZone)}`;
  return `Custom price${on}${from}`;
}

/** "$3.00 input, $15.00 output, $0.30 cache read, cache write as input, per million tokens". */
const ratesText = (rates: AiCallPrice["rates"]) =>
  `${[
    `${perMillion.format(rates.input)} input`,
    `${perMillion.format(rates.output)} output`,
    rates.cacheRead === null
      ? "cache read as input"
      : `${perMillion.format(rates.cacheRead)} cache read`,
    rates.cacheWrite === null
      ? "cache write as input"
      : `${perMillion.format(rates.cacheWrite)} cache write`,
  ].join(", ")}, per million tokens`;

/** One fact: its label over its value; a missing value is a dash named in words. */
function Fact({
  label,
  children,
  missing = "None",
  wide = false,
}: {
  label: string;
  children: React.ReactNode;
  /** What a screen reader hears for a missing value. */
  missing?: string;
  wide?: boolean;
}) {
  const empty = children === null || children === undefined || children === "";
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${wide ? "col-span-full" : ""}`}>
      <dt className="text-xs text-ink-subtle">{label}</dt>
      <dd className="min-w-0 text-sm break-words text-ink">
        {empty ? <Missing label={missing} className="text-ink-subtle" /> : children}
      </dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const id = React.useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 border-t pt-5">
      <h3 id={id} className="text-base font-medium text-ink">
        {title}
      </h3>
      {children}
    </section>
  );
}

const FACTS = "grid grid-cols-2 gap-x-6 gap-y-4 @xl:grid-cols-3";

/** The address of the AI calls page in the Conversations view with `conversationId` chosen. */
const conversationSearch = (place: AiCallsPlace, conversationId: string) =>
  aiCallsSearchOf({
    range: place.range,
    environment: place.environment,
    filters: { ...place.filters, conversation: conversationId },
    view: "conversations",
  });

/** The address of the AI calls page listing only `conversationId`'s calls. */
const conversationCallsSearch = (place: AiCallsPlace, conversationId: string) =>
  aiCallsSearchOf({
    range: place.range,
    environment: place.environment,
    filters: { conversation: conversationId },
  });

function Loading({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label={label}>
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

function Failure({ title, error, retry }: { title: string; error: Error; retry: () => void }) {
  return (
    <Alert variant="destructive">
      <OctagonAlertIcon />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{error.message}</AlertDescription>
      <AlertAction>
        <Button variant="outline" size="sm" onClick={retry}>
          Retry
        </Button>
      </AlertAction>
    </Alert>
  );
}

/**
 * One AI call: every field stored of it, its estimated cost with where the
 * price comes from, its trace, and its conversation. On its own page
 * (under 64rem) and beside the list (`inWorkbench`), where links to a
 * conversation stay on the workbench.
 */
export function CallView({
  place,
  callId,
  at,
  inWorkbench = false,
  actions,
}: {
  place: AiCallsPlace;
  callId: string;
  /** When it started, when known: where it is looked for. */
  at: string | undefined;
  inWorkbench?: boolean;
  /** Beside its name, such as a link to its own page. */
  actions?: React.ReactNode;
}) {
  const { projectId } = place;
  const query = useQuery(aiCallQuery(projectId, callId, at));
  if (query.error instanceof ApiError && query.error.status === 404) {
    if (query.error.code !== "no_such_call") return <NoSuchProject />;
    return (
      <Empty className="border border-dashed p-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchXIcon />
          </EmptyMedia>
          <EmptyTitle>No AI call with this ID</EmptyTitle>
          <EmptyDescription>
            The link may be cut short, or the call was deleted with the project&apos;s older events.
          </EmptyDescription>
        </EmptyHeader>
        <Link
          to="/projects/$projectId/ai/calls"
          params={{ projectId }}
          search={
            inWorkbench
              ? (previous) => ({ ...previous, call: undefined, at: undefined })
              : aiCallsSearchOf(place)
          }
          className="text-sm text-link hover:underline"
        >
          All calls
        </Link>
      </Empty>
    );
  }
  if (query.isPending) return <Loading label="Loading the call" />;
  if (query.isError) {
    return (
      <Failure
        title="The call could not load"
        error={query.error}
        retry={() => void query.refetch()}
      />
    );
  }
  const { call, price, timeZone } = query.data;
  const name = modelLabel(call.model);
  return (
    <div className="@container flex min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          {inWorkbench ? (
            <h2 className="text-xl font-semibold break-words text-ink">{name}</h2>
          ) : (
            <PageTitle title={name} />
          )}
          <p className="text-sm text-ink-muted">
            {call.provider}, {formatPreciseMoment(call.at, timeZone)}
          </p>
        </div>
        {actions}
      </div>

      <dl className={FACTS}>
        <Fact label="Status">
          <CallStatus call={call} />
        </Fact>
        <Fact label="Estimated cost" missing="No price">
          {call.costUsd === null ? null : formatUsd(call.costUsd)}
        </Fact>
        <Fact label="Duration">{formatMs(call.durationMs)}</Fact>
        <Fact label="Time to first chunk" missing="Not sent">
          {call.firstChunkMs === null ? null : formatMs(call.firstChunkMs)}
        </Fact>
        <Fact label="Input tokens">{formatWhole(call.inputTokens)}</Fact>
        <Fact label="Output tokens">{formatWhole(call.outputTokens)}</Fact>
        <Fact label="Cache read tokens">{formatWhole(call.cacheReadTokens)}</Fact>
        <Fact label="Cache write tokens">{formatWhole(call.cacheWriteTokens)}</Fact>
        <Fact label="Reasoning tokens">{formatWhole(call.reasoningTokens)}</Fact>
      </dl>

      <Section title="Call">
        <dl className={FACTS}>
          <Fact label="Provider">{call.provider}</Fact>
          <Fact label="Model" missing="Not named">
            {call.model}
          </Fact>
          <Fact label="Operation" missing="Not sent">
            {call.operation}
          </Fact>
          <Fact label="Feature">
            <span className={call.feature === "" ? "text-ink-subtle" : undefined}>
              {featureLabel(call.feature)}
            </span>
          </Fact>
          {!query.data.usersHidden && (
            <Fact label="User" missing="No user">
              {call.userId === null ? null : (
                <Link
                  to="/projects/$projectId/users/$userId"
                  params={{ projectId, userId: call.userId }}
                  search={environmentSearch(call.environment)}
                  className="break-all text-link hover:underline"
                >
                  {call.userId}
                </Link>
              )}
            </Fact>
          )}
          <Fact label="Service" missing="Not sent">
            {call.service}
          </Fact>
          <Fact label="Environment">{call.environment}</Fact>
          <Fact label="Release" missing="Not sent">
            {call.release}
          </Fact>
          <Fact label="Started">{formatPreciseMoment(call.at, timeZone)}</Fact>
          <Fact label="Finish reasons" missing="Not sent">
            {call.finishReasons.join(", ")}
          </Fact>
          <Fact label="Error type" missing="None">
            {call.errorType}
          </Fact>
        </dl>
      </Section>

      <Section title="Estimated cost">
        {price === null ? (
          <p className="text-sm text-pretty text-ink">
            {call.model === ""
              ? "The call names no model, so it has no price."
              : `${call.model} has no price, so this call is not in the cost.`}
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
        ) : (
          <div className="flex flex-col gap-1 text-sm">
            <p className="text-ink">
              <span className="font-medium tabular-nums">
                <CallCost costUsd={call.costUsd} />
              </span>
              {" from "}
              {priceSourceText(price, timeZone)}
            </p>
            <p className="text-ink-muted">{ratesText(price.rates)}</p>
          </div>
        )}
        <p className="text-xs text-ink-subtle">{COST_NOTE}</p>
      </Section>

      <Section title="Trace">
        {call.traceId === "" ? (
          <p className="text-sm text-ink-muted">Sent over HTTP without a trace.</p>
        ) : query.data.traceKept ? (
          <div className="flex flex-col gap-1">
            <Link
              to="/projects/$projectId/traces/$traceId"
              params={{ projectId, traceId: call.traceId }}
              search={{ at: call.at, span: call.spanId === "" ? undefined : call.spanId }}
              className="self-start text-sm text-link hover:underline"
            >
              Open its trace
            </Link>
            <p className="font-mono text-xs break-all text-ink-subtle">{call.traceId}</p>
          </div>
        ) : (
          <p className="text-sm text-pretty text-ink-muted">
            Traces are kept {formatWhole(query.data.traceRetentionDays)} days, so this call&apos;s
            trace is gone. The call is kept as long as the project&apos;s events.
          </p>
        )}
      </Section>

      <Section title="Conversation">
        {call.conversationId === "" ? (
          <p className="text-sm text-ink-muted">Not part of a conversation.</p>
        ) : (
          <div className="flex flex-col gap-1 text-sm">
            <TruncatedText
              text={call.conversationId}
              className="self-start font-mono text-link hover:underline"
              render={
                <Link
                  to="/projects/$projectId/ai/calls"
                  params={{ projectId }}
                  search={conversationSearch(place, call.conversationId)}
                  aria-label={`Open the conversation ${call.conversationId}`}
                />
              }
            />
            <Link
              to="/projects/$projectId/ai/calls"
              params={{ projectId }}
              search={conversationCallsSearch(place, call.conversationId)}
              className="self-start text-link hover:underline"
            >
              List its calls
            </Link>
          </div>
        )}
      </Section>
    </div>
  );
}

/** One call on its own page, for narrow screens and links. */
export function CallPage({
  place,
  callId,
  at,
}: {
  place: AiCallsPlace;
  callId: string;
  at: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-6 px-gutter py-5">
      <Link
        to="/projects/$projectId/ai/calls"
        params={{ projectId: place.projectId }}
        search={aiCallsSearchOf(place)}
        className="inline-flex items-center gap-1 self-start text-sm text-link hover:underline"
      >
        <ArrowLeftIcon aria-hidden="true" className="size-4" />
        All calls
      </Link>
      <CallView place={place} callId={callId} at={at} />
    </div>
  );
}

const sameDay = (a: string, b: string, timeZone: string) =>
  formatDate(a, timeZone) === formatDate(b, timeZone);

/** "07:38:12", the time of a turn. */
const formatClock = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone,
  }).format(new Date(iso));

const HEAD = "h-8 text-xs font-normal text-ink-subtle";

/** A conversation's calls in order: each turn's time opens it in the list. */
function Turns({ place, detail }: { place: AiCallsPlace; detail: AiConversationDetail }) {
  const { calls, timeZone } = detail;
  const first = calls[0]?.at;
  const last = calls.at(-1)?.at;
  const oneDay = first === undefined || last === undefined || sameDay(first, last, timeZone);
  return (
    <Table className="table-fixed">
      <caption className="sr-only">The conversation&apos;s calls, in order</caption>
      <colgroup>
        <col className="w-9" />
        <col className={oneDay ? "w-24" : "w-40"} />
        <col />
        <col className="w-20" />
        <col className="w-24" />
        <col className="w-20" />
        <col className="w-28" />
      </colgroup>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead scope="col" className={`${HEAD} pl-0`}>
            <span className="sr-only">Turn</span>#
          </TableHead>
          <TableHead scope="col" className={HEAD}>
            Started
          </TableHead>
          <TableHead scope="col" className={HEAD}>
            Model
          </TableHead>
          <TableHead scope="col" className={`${HEAD} text-right`}>
            Tokens
          </TableHead>
          <TableHead scope="col" className={`${HEAD} text-right`}>
            Est. cost
          </TableHead>
          <TableHead scope="col" className={`${HEAD} text-right`}>
            Duration
          </TableHead>
          <TableHead scope="col" className={`${HEAD} pr-0`}>
            Status
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {calls.map((call, index) => (
          <TableRow key={call.id} {...clickableRow()}>
            <TableCell className="pl-0 align-top text-ink-subtle tabular-nums">
              {formatWhole(index + 1)}
            </TableCell>
            <TableCell className="align-top tabular-nums">
              <Link
                to="/projects/$projectId/ai/calls"
                params={{ projectId: place.projectId }}
                search={{
                  ...aiCallsSearchOf({
                    range: place.range,
                    environment: place.environment,
                    filters: { conversation: detail.conversationId },
                  }),
                  call: call.id,
                  at: call.at,
                }}
                className="text-link hover:underline"
                aria-label={`Turn ${formatWhole(index + 1)}, ${formatPreciseMoment(call.at, timeZone)}`}
                {...ROW_LINK}
              >
                {oneDay ? formatClock(call.at, timeZone) : formatMoment(call.at, timeZone)}
              </Link>
            </TableCell>
            <TableCell className="align-top">
              <TruncatedText text={modelLabel(call.model)} className="text-ink" />
            </TableCell>
            <TableCell className="text-right align-top tabular-nums">
              <span className="block">{formatTokens(call.inputTokens)} in</span>
              <span className="block text-ink-subtle">{formatTokens(call.outputTokens)} out</span>
            </TableCell>
            <TableCell className="text-right align-top tabular-nums">
              <CallCost costUsd={call.costUsd} />
            </TableCell>
            <TableCell className="text-right align-top tabular-nums">
              {formatMs(call.durationMs)}
            </TableCell>
            <TableCell className="pr-0 align-top">
              <CallStatus call={call} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * One conversation: its figures in the period and its calls in order, each
 * opening in the list. On its own page (under 64rem) and beside the
 * Conversations list (`inWorkbench`).
 */
export function ConversationView({
  place,
  conversationId,
  inWorkbench = false,
  actions,
}: {
  place: AiCallsPlace;
  conversationId: string;
  inWorkbench?: boolean;
  actions?: React.ReactNode;
}) {
  const { projectId } = place;
  const query = useQuery(
    aiConversationQuery(projectId, conversationId, place.range, place.environment, place.filters),
  );
  if (query.error instanceof ApiError && query.error.status === 404) return <NoSuchProject />;
  const heading = (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="flex min-w-0 flex-col gap-1">
        {inWorkbench ? (
          <h2 className="font-mono text-xl font-semibold break-all text-ink">{conversationId}</h2>
        ) : (
          <PageTitle title={conversationId} />
        )}
        <p className="text-sm text-ink-muted">Conversation</p>
      </div>
      {actions}
    </div>
  );
  if (query.isPending) {
    return (
      <div className="flex flex-col gap-6">
        {heading}
        <Loading label="Loading the conversation" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="flex flex-col gap-6">
        {heading}
        <Failure
          title="The conversation could not load"
          error={query.error}
          retry={() => void query.refetch()}
        />
      </div>
    );
  }
  const detail = query.data;
  const { figures, calls, timeZone } = detail;
  const users = [...new Set(calls.flatMap((call) => (call.userId === null ? [] : [call.userId])))];
  const features = [...new Set(calls.map((call) => featureLabel(call.feature)))];
  const models = [...new Set(calls.map((call) => modelLabel(call.model)))];
  return (
    <div className="@container flex min-w-0 flex-col gap-6">
      {heading}
      {figures === null ? (
        <Empty className="border border-dashed p-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchXIcon />
            </EmptyMedia>
            <EmptyTitle>No calls of this conversation in this period</EmptyTitle>
            <EmptyDescription>Choose a longer period, or clear a filter.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <dl className={FACTS}>
            <Fact label="Turns">{formatWhole(figures.calls)}</Fact>
            <Fact label="Estimated cost">{formatUsd(figures.costUsd)}</Fact>
            <Fact label="Failed turns">{formatWhole(figures.failed)}</Fact>
            <Fact label="Input tokens">{formatWhole(figures.inputTokens)}</Fact>
            <Fact label="Output tokens">{formatWhole(figures.outputTokens)}</Fact>
            <Fact label="Total duration">{formatMs(figures.durationMs)}</Fact>
            <Fact label="Started">{formatPreciseMoment(figures.startedAt, timeZone)}</Fact>
            <Fact label="Last call">{formatPreciseMoment(figures.lastAt, timeZone)}</Fact>
            {!detail.usersHidden && (
              <Fact label={users.length > 1 ? "Users" : "User"} missing="No user">
                {users.length === 0
                  ? null
                  : users.map((userId, index) => (
                      <React.Fragment key={userId}>
                        {index > 0 && ", "}
                        <Link
                          to="/projects/$projectId/users/$userId"
                          params={{ projectId, userId }}
                          search={environmentSearch(place.environment)}
                          className="break-all text-link hover:underline"
                        >
                          {userId}
                        </Link>
                      </React.Fragment>
                    ))}
              </Fact>
            )}
            <Fact label={features.length > 1 ? "Features" : "Feature"}>{features.join(", ")}</Fact>
            <Fact label={models.length > 1 ? "Models" : "Model"} wide>
              {models.join(", ")}
            </Fact>
          </dl>
          <p className="text-xs text-pretty text-ink-subtle">
            {figures.noPriceCalls > 0 &&
              `${formatWhole(figures.noPriceCalls)} ${figures.noPriceCalls === 1 ? "call had" : "calls had"} no price and ${figures.noPriceCalls === 1 ? "is" : "are"} not in the cost. `}
            {COST_NOTE} The figures cover its calls in this period.
          </p>
          <Section title="Calls">
            {detail.more && (
              <p className="text-sm text-ink-muted">
                The first {formatWhole(detail.limit)} of {formatWhole(figures.calls)} calls.
              </p>
            )}
            <Turns place={place} detail={detail} />
            <Link
              to="/projects/$projectId/ai/calls"
              params={{ projectId }}
              search={conversationCallsSearch(place, conversationId)}
              className="self-start text-sm text-link hover:underline"
            >
              List these calls
            </Link>
          </Section>
        </>
      )}
    </div>
  );
}

/** One conversation on its own page, for narrow screens and links. */
export function ConversationPage({
  place,
  conversationId,
}: {
  place: AiCallsPlace;
  conversationId: string;
}) {
  return (
    <div className="flex flex-col gap-6 px-gutter py-5">
      <Link
        to="/projects/$projectId/ai/calls"
        params={{ projectId: place.projectId }}
        search={aiCallsSearchOf({
          ...place,
          filters: { ...place.filters, conversation: undefined },
          view: "conversations",
        })}
        className="inline-flex items-center gap-1 self-start text-sm text-link hover:underline"
      >
        <ArrowLeftIcon aria-hidden="true" className="size-4" />
        All conversations
      </Link>
      <ConversationView place={place} conversationId={conversationId} />
    </div>
  );
}
