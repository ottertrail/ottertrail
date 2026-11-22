import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  MessagesSquareIcon,
  OctagonAlertIcon,
  SearchXIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import * as React from "react";

import { ButtonAnchor } from "@/components/button-anchor";
import { ButtonLink } from "@/components/button-link";
import { FilterBarRange } from "@/components/filter-bar";
import { type Stat, StatStrip } from "@/components/stat-strip";
import { StatusBadge } from "@/components/status-badge";
import { TruncatedText } from "@/components/truncated-text";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Workbench,
  WorkbenchKeyHints,
  type WorkbenchListProps,
  WorkbenchStartHint,
} from "@/components/workbench";
import {
  atLeast,
  GUTTER_END,
  GUTTER_START,
  LIST_HEAD,
  ROW_LINK,
  selectOnPlainClick,
  workbenchRow,
} from "@/components/workbench-rows";
import { NARROW_WORKBENCH, PHONE, useMediaQuery } from "@/hooks/use-media-query";
import {
  type AiCallFilters,
  aiCallListQuery,
  type AiCallFirstPage,
  isFirstPage,
  type AiConversationList,
  type AiConversationRow,
  aiConversationsQuery,
  type AiListedCall,
} from "@/lib/ai-calls-api";
import { DEFAULT_ENVIRONMENT, type PageRange } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import { AI_DOCS_URL } from "@/lib/docs";
import { MISSING } from "@/lib/missing";

import { formatConversion, formatWhole } from "../analytics/format";
import { ReportFilterBar } from "../errors/range-controls";
import { NoSuchProject } from "../projects/no-such-project";
import { ChoiceFilter, TextFilter } from "../telemetry/filters";
import { formatMoment } from "../users/format";
import { CallCost, CallStatus, CallView, COST_NOTE, ConversationView } from "./call-view";
import { type AiCallsPlace, aiCallsSearchOf, type AiCallsView } from "./calls-search";
import { featureLabel, formatMs, formatTokens, formatUsd, modelLabel } from "./format";

/** A filter's choices: the values the period offers, each with its label. */
const choices = (values: readonly string[] | undefined, label = (value: string) => value) =>
  (values ?? []).map((value) => ({ value, label: label(value) }));

/** Whether any filter but the conversation narrows the list. */
const narrowed = (filters: AiCallFilters) =>
  Object.entries(filters).some(([key, value]) => key !== "conversation" && value !== undefined);

const VIEWS = [
  { value: "calls", label: "Calls" },
  { value: "conversations", label: "Conversations" },
] as const;
const STATUSES = [
  { value: "all", label: "All" },
  { value: "failed", label: "Failed" },
] as const;

/** The listed calls, newest first: the model (the row's link), what made it, and its figures. */
function CallTable({
  calls,
  place,
  timeZone,
  usersHidden,
  selected,
  select,
}: {
  calls: readonly AiListedCall[];
  place: AiCallsPlace;
  timeZone: string;
  usersHidden: boolean;
} & WorkbenchListProps) {
  // A phone leaves out the tokens, which the call's page has.
  const phone = useMediaQuery(PHONE);
  return (
    <Table className="table-fixed">
      <caption className="sr-only">AI calls, newest first</caption>
      <colgroup>
        <col />
        {!phone && <col className="w-24" />}
        <col className="w-24" />
        <col className="w-20" />
      </colgroup>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead scope="col" className={`${LIST_HEAD} ${GUTTER_START}`}>
            Call
          </TableHead>
          {!phone && (
            <TableHead scope="col" className={`${LIST_HEAD} text-right`}>
              Tokens
            </TableHead>
          )}
          <TableHead scope="col" className={`${LIST_HEAD} text-right`}>
            Est. cost
          </TableHead>
          <TableHead scope="col" className={`${LIST_HEAD} text-right ${GUTTER_END}`}>
            Duration
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {calls.map((call) => {
          const chosen = call.id === selected;
          return (
            <TableRow key={call.id} {...workbenchRow(call.id, chosen)}>
              <TableCell className={`${GUTTER_START} py-2.5 align-top whitespace-normal`}>
                <TruncatedText
                  text={modelLabel(call.model)}
                  className="rounded-sm font-medium text-link hover:underline"
                  render={
                    <Link
                      to="/projects/$projectId/ai/calls/$callId"
                      params={{ projectId: place.projectId, callId: call.id }}
                      search={{ ...aiCallsSearchOf(place), at: call.at }}
                      aria-current={chosen ? "true" : undefined}
                      {...ROW_LINK}
                      onClick={selectOnPlainClick(select, call.id)}
                    />
                  }
                />
                <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-subtle">
                  <TruncatedText text={call.provider} className="max-w-32" />
                  <time dateTime={call.at} className="whitespace-nowrap tabular-nums">
                    {formatMoment(call.at, timeZone)}
                  </time>
                  <TruncatedText text={featureLabel(call.feature)} className="max-w-40" />
                  {!usersHidden && call.userId !== null && (
                    <TruncatedText text={`User ${call.userId}`} className="max-w-40" />
                  )}
                  {call.failed && <CallStatus call={call} />}
                </p>
              </TableCell>
              {!phone && (
                <TableCell className="py-2.5 text-right align-top tabular-nums">
                  <span className="block">{formatTokens(call.inputTokens)} in</span>
                  <span className="block text-ink-subtle">
                    {formatTokens(call.outputTokens)} out
                  </span>
                </TableCell>
              )}
              <TableCell className="py-2.5 text-right align-top tabular-nums">
                <CallCost costUsd={call.costUsd} />
              </TableCell>
              <TableCell className={`py-2.5 text-right align-top tabular-nums ${GUTTER_END}`}>
                {formatMs(call.durationMs)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** "N calls had no price and are not in the cost." */
const noPriceLine = (calls: number) =>
  calls === 0
    ? ""
    : `${formatWhole(calls)} ${calls === 1 ? "call had" : "calls had"} no price and ${calls === 1 ? "is" : "are"} not in the cost. `;

/** With nothing selected: the period's calls with the filters, counted whole by the API. */
function CallsSummary({ first }: { first: AiCallFirstPage }) {
  const { totals } = first;
  const stats: Stat[] = [
    { label: "Calls", value: formatWhole(totals.calls) },
    { label: "Estimated cost (USD)", value: formatUsd(totals.costUsd) },
    {
      label: "Failed",
      value: totals.failedShare === null ? MISSING : formatConversion(totals.failedShare),
    },
  ];
  return (
    <div className="flex flex-col gap-6 px-gutter py-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold text-ink">This period</h2>
        <FilterBarRange
          firstDay={first.firstDay}
          lastDay={first.lastDay}
          timeZone={first.timeZone}
        />
      </div>
      <section aria-label="Calls in this period" className="flex flex-col gap-3 border-t pt-5">
        <StatStrip label="Calls in this period" stats={stats} />
        <p className="text-xs text-pretty text-ink-subtle">
          Every call with these filters in this period and environment.{" "}
          {noPriceLine(totals.noPriceCalls)}
          {COST_NOTE}
        </p>
      </section>
      <WorkbenchStartHint noun="a call" />
    </div>
  );
}

/** With nothing selected: the conversations listed, at least that many when some were left out. */
function ConversationsSummary({ list }: { list: AiConversationList }) {
  const { conversations, more } = list;
  const turns = conversations.reduce((total, row) => total + row.calls, 0);
  const cost = conversations.reduce((total, row) => total + row.costUsd, 0);
  const unpriced = conversations.reduce((total, row) => total + row.noPriceCalls, 0);
  const stats: Stat[] = [
    { label: "Conversations", value: atLeast(conversations.length, more) },
    { label: "Turns", value: atLeast(turns, more) },
    { label: "Estimated cost (USD)", value: `${formatUsd(cost)}${more ? "+" : ""}` },
  ];
  return (
    <div className="flex flex-col gap-6 px-gutter py-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold text-ink">This period</h2>
        <FilterBarRange firstDay={list.firstDay} lastDay={list.lastDay} timeZone={list.timeZone} />
      </div>
      <section aria-label="Conversations in the list" className="flex flex-col gap-3 border-t pt-5">
        <StatStrip label="Conversations in the list" stats={stats} />
        <p className="text-xs text-pretty text-ink-subtle">
          {more
            ? `These count the ${formatWhole(list.limit)} conversations with the latest calls, so each is at least that many. Choose a shorter period to see the rest. `
            : "These count every conversation in the list. "}
          {noPriceLine(unpriced)}
          {COST_NOTE}
        </p>
      </section>
      <WorkbenchStartHint noun="a conversation" />
    </div>
  );
}

/** The period's conversations, by their last call: the ID (the row's link), who, and its figures. */
function ConversationTable({
  conversations,
  place,
  timeZone,
  selected,
  select,
}: {
  conversations: readonly AiConversationRow[];
  place: AiCallsPlace;
  timeZone: string;
} & WorkbenchListProps) {
  const phone = useMediaQuery(PHONE);
  return (
    <Table className="table-fixed">
      <caption className="sr-only">Conversations, by their last call, newest first</caption>
      <colgroup>
        <col />
        <col className="w-16" />
        {!phone && <col className="w-24" />}
        <col className="w-24" />
      </colgroup>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead scope="col" className={`${LIST_HEAD} ${GUTTER_START}`}>
            Conversation
          </TableHead>
          <TableHead scope="col" className={`${LIST_HEAD} text-right`}>
            Turns
          </TableHead>
          {!phone && (
            <TableHead scope="col" className={`${LIST_HEAD} text-right`}>
              Tokens
            </TableHead>
          )}
          <TableHead scope="col" className={`${LIST_HEAD} text-right ${GUTTER_END}`}>
            Est. cost
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {conversations.map((row) => {
          const chosen = row.conversationId === selected;
          return (
            <TableRow key={row.conversationId} {...workbenchRow(row.conversationId, chosen)}>
              <TableCell className={`${GUTTER_START} py-2.5 align-top whitespace-normal`}>
                <TruncatedText
                  text={row.conversationId}
                  className="rounded-sm font-mono font-medium text-link hover:underline"
                  render={
                    <Link
                      to="/projects/$projectId/ai/conversations/$conversationId"
                      params={{ projectId: place.projectId, conversationId: row.conversationId }}
                      search={aiCallsSearchOf({
                        ...place,
                        filters: { ...place.filters, conversation: undefined },
                      })}
                      aria-current={chosen ? "true" : undefined}
                      {...ROW_LINK}
                      onClick={selectOnPlainClick(select, row.conversationId)}
                    />
                  }
                />
                <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-subtle">
                  <span className="tabular-nums">
                    Last call{" "}
                    <time dateTime={row.lastAt}>{formatMoment(row.lastAt, timeZone)}</time>
                  </span>
                  {row.userId !== null && (
                    <TruncatedText text={`User ${row.userId}`} className="max-w-40" />
                  )}
                  <TruncatedText
                    text={row.models.map(modelLabel).join(", ")}
                    className="max-w-48"
                  />
                  {row.failed > 0 && (
                    <StatusBadge tone="critical">{formatWhole(row.failed)} failed</StatusBadge>
                  )}
                </p>
              </TableCell>
              <TableCell className="py-2.5 text-right align-top tabular-nums">
                {formatWhole(row.calls)}
              </TableCell>
              {!phone && (
                <TableCell className="py-2.5 text-right align-top tabular-nums">
                  {formatTokens(row.inputTokens + row.outputTokens)}
                </TableCell>
              )}
              <TableCell className={`py-2.5 text-right align-top tabular-nums ${GUTTER_END}`}>
                {row.calls === row.noPriceCalls ? (
                  <CallCost costUsd={null} />
                ) : (
                  formatUsd(row.costUsd)
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/**
 * A filter set by a link with no field of its own: the Calls view's
 * conversation (from a call or a conversation), or a user for a reader
 * without the Users area. Its value, and a button that removes it.
 */
function FilterChip({
  text,
  removeLabel,
  onRemove,
}: {
  text: string;
  removeLabel: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex h-7 max-w-64 min-w-0 items-center gap-1 rounded-4xl bg-muted pr-1 pl-3 text-sm text-ink">
      <TruncatedText text={text} className="min-w-0" />
      <button
        type="button"
        className="inline-flex size-5 shrink-0 items-center justify-center rounded-4xl text-ink-subtle hover:bg-accent hover:text-ink focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        aria-label={removeLabel}
        onClick={onRemove}
      >
        <XIcon aria-hidden="true" className="size-3.5" />
      </button>
    </span>
  );
}

function ListFailure({
  what,
  loaded,
  error,
  retry,
}: {
  what: string;
  loaded: boolean;
  error: Error;
  retry: () => void;
}) {
  return (
    <Alert variant="destructive">
      <OctagonAlertIcon />
      <AlertTitle>
        {loaded ? `The ${what} could not refresh` : `The ${what} could not load`}
      </AlertTitle>
      <AlertDescription>
        {error.message}
        {loaded && " The list below is from the last successful load."}
      </AlertDescription>
      <AlertAction>
        <Button variant="outline" size="sm" onClick={retry}>
          Retry
        </Button>
      </AlertAction>
    </Alert>
  );
}

function ListLoading() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading the list">
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-12 w-full" />
    </div>
  );
}

/** While the project has never sent an AI call: where to read how. */
function NoCallsYet() {
  return (
    <Empty className="border border-dashed p-10">
      <EmptyHeader className="max-w-xl">
        <EmptyMedia variant="icon">
          <SparklesIcon />
        </EmptyMedia>
        <EmptyTitle>No AI calls yet</EmptyTitle>
        <EmptyDescription>
          Send traces over OpenTelemetry with a GenAI instrumentation, or send each call from your
          server over HTTP.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <DocsButton>How to send AI calls</DocsButton>
      </EmptyContent>
    </Empty>
  );
}

function DocsButton({ children }: { children: React.ReactNode }) {
  return (
    <ButtonAnchor variant="outline" href={AI_DOCS_URL} target="_blank" rel="noopener noreferrer">
      {children}
      <ArrowUpRightIcon aria-hidden="true" />
      <span className="sr-only">(opens in a new tab)</span>
    </ButtonAnchor>
  );
}

const notFound = (error: Error | null) => error instanceof ApiError && error.status === 404;

/**
 * The project's AI calls as a workbench (docs/ai-usage.md, "The calls
 * list"; docs/design-system.md, "Workbench"): every call of the period,
 * newest first, a hundred at a time, beside the selected call; or, in the
 * Conversations view, the conversations the calls make, by their last
 * call, beside the selected one's calls. Every filter is in the address.
 * Under 64rem a row opens its own page.
 */
export function AiCallsPage({
  projectId,
  range,
  environment = DEFAULT_ENVIRONMENT,
  filters,
  view,
  at,
}: {
  projectId: string;
  range: PageRange;
  environment?: string;
  filters: AiCallFilters;
  view: AiCallsView;
  /** When the selected call started, from the address: for a call the list does not hold. */
  at?: string | undefined;
}) {
  const navigate = useNavigate();
  const narrow = useMediaQuery(NARROW_WORKBENCH);
  const callsView = view === "calls";
  const list = useInfiniteQuery({
    ...aiCallListQuery(projectId, range, environment, filters),
    enabled: callsView,
  });
  const conversations = useQuery({
    ...aiConversationsQuery(projectId, range, environment, filters),
    enabled: !callsView,
  });
  const place: AiCallsPlace = { projectId, range, environment, filters };

  const calls = (list.data?.pages ?? []).flatMap((page) => page.calls);
  // When a call ran: its row's start, else what the address says (a link from elsewhere).
  const atOf = (callId: string) => calls.find((call) => call.id === callId)?.at ?? at;

  /** A new address for the list: the selection, and when the selected call ran, kept. */
  const show = (next: {
    range?: PageRange;
    environment?: string;
    filters?: AiCallFilters;
    view?: AiCallsView;
  }) =>
    void navigate({
      to: "/projects/$projectId/ai/calls",
      params: { projectId },
      search: (previous: Record<string, unknown>) => {
        const nextView = next.view ?? view;
        const keepCall = nextView === "calls" && typeof previous.call === "string";
        return {
          ...aiCallsSearchOf({
            range: next.range ?? range,
            environment: next.environment ?? environment,
            filters: next.filters ?? filters,
            view: nextView,
          }),
          ...(keepCall ? { call: previous.call, at: previous.at } : {}),
        };
      },
    });
  const filter = (changes: AiCallFilters) => show({ filters: { ...filters, ...changes } });

  if (notFound(list.error) || notFound(conversations.error)) return <NoSuchProject />;

  const firstPage = list.data?.pages[0];
  const firstCalls = firstPage !== undefined && isFirstPage(firstPage) ? firstPage : undefined;
  const first = callsView ? firstCalls : conversations.data;
  const options = first?.filterOptions;
  const usersHidden = first?.usersHidden ?? true;

  const filterBar = (
    <ReportFilterBar
      label="Period, environment, and filters"
      range={range}
      environment={environment}
      answered={first}
      onRange={(next) => show({ range: next })}
      onEnvironment={(next) =>
        show({ environment: next, filters: { ...filters, service: undefined } })
      }
      filters={
        first?.received !== false && (
          <>
            <ToggleGroup
              value={[view]}
              onValueChange={(value) => {
                const [next] = value;
                if (next === "calls" || next === "conversations") show({ view: next });
              }}
              aria-label="Which list to show"
              variant="outline"
              size="sm"
              spacing={0}
            >
              {VIEWS.map((item) => (
                <ToggleGroupItem key={item.value} value={item.value}>
                  {item.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <ChoiceFilter
              label="Model"
              anyLabel="Any model"
              choices={choices(options?.models, modelLabel)}
              value={filters.model}
              onChange={(model) => filter({ model })}
              className="w-40"
            />
            <ChoiceFilter
              label="Feature"
              anyLabel="Any feature"
              choices={choices(options?.features, featureLabel)}
              value={filters.feature}
              onChange={(feature) => filter({ feature })}
              className="w-36"
            />
            <ChoiceFilter
              label="Service"
              anyLabel="Any service"
              choices={choices(options?.services)}
              value={filters.service}
              onChange={(service) => filter({ service })}
              className="w-32"
            />
            {filters.provider !== undefined && (
              <ChoiceFilter
                label="Provider"
                anyLabel="Any provider"
                choices={choices(options?.providers)}
                value={filters.provider}
                onChange={(provider) => filter({ provider })}
                className="w-32"
              />
            )}
            {/* A user filter from a link stays removable for a reader without the Users area, whose list it refuses. */}
            {filters.user !== undefined && usersHidden && (
              <FilterChip
                text={`User ${filters.user}`}
                removeLabel={`Remove the filter user ${filters.user}`}
                onRemove={() => filter({ user: undefined })}
              />
            )}
            {!usersHidden && (
              <TextFilter
                label="User ID"
                placeholder="User ID…"
                value={filters.user}
                onChange={(user) => filter({ user })}
                className="w-32"
              />
            )}
            <ToggleGroup
              value={[filters.failed === true ? "failed" : "all"]}
              onValueChange={(value) => {
                const [next] = value;
                if (next === "all" || next === "failed") {
                  filter({ failed: next === "failed" ? true : undefined });
                }
              }}
              aria-label={callsView ? "Which calls to list" : "Which conversations to list"}
              variant="outline"
              size="sm"
              spacing={0}
            >
              {STATUSES.map((item) => (
                <ToggleGroupItem key={item.value} value={item.value}>
                  {item.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            {callsView && filters.conversation !== undefined && (
              <FilterChip
                text={`Conversation ${filters.conversation}`}
                removeLabel={`Remove the filter conversation ${filters.conversation}`}
                onRemove={() => filter({ conversation: undefined })}
              />
            )}
          </>
        )
      }
      actions={first?.received === true && <WorkbenchKeyHints />}
    />
  );

  const query = callsView ? list : conversations;
  const failure = query.isError && (
    <ListFailure
      what={callsView ? "AI calls" : "conversations"}
      loaded={first !== undefined}
      error={query.error}
      retry={() => void query.refetch()}
    />
  );

  if (first === undefined || !first.received) {
    return (
      <div className="flex flex-col">
        {filterBar}
        <div className="px-gutter py-5">
          {first !== undefined ? <NoCallsYet /> : query.isError ? failure : <ListLoading />}
        </div>
      </div>
    );
  }

  const stale = (children: React.ReactNode, placeholder: boolean) => (
    <div
      className="flex flex-col transition-opacity data-[stale=true]:opacity-60"
      data-stale={placeholder}
      aria-busy={placeholder}
    >
      {query.isError && <div className="px-gutter pt-4">{failure}</div>}
      {children}
    </div>
  );

  if (callsView) {
    const page = firstCalls;
    if (page === undefined) return null;
    const filtered = narrowed(filters) || filters.conversation !== undefined;
    const guidance = (
      <Empty className="border border-dashed p-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchXIcon />
          </EmptyMedia>
          <EmptyTitle>
            {filtered ? "No call matches these filters" : "No AI calls in this period"}
          </EmptyTitle>
          <EmptyDescription>
            {filtered
              ? "Change or clear a filter, or choose a longer period."
              : `No call arrived${environment === DEFAULT_ENVIRONMENT ? "" : ` in ${environment}`} in this period. Choose a longer period.`}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
    const empty = calls.length === 0;
    return (
      <div className="flex flex-col min-[64rem]:h-full min-[64rem]:min-h-0">
        {filterBar}
        <Workbench
          key="calls"
          label="AI calls"
          className="min-[64rem]:min-h-0 min-[64rem]:flex-1"
          ids={calls.map((call) => call.id)}
          param="call"
          // A call chosen is looked for at its start.
          selectionSearch={(id) => ({ at: id === undefined ? undefined : atOf(id) })}
          filterKey={JSON.stringify([range, environment, filters])}
          onOpenPage={(callId) =>
            void navigate({
              to: "/projects/$projectId/ai/calls/$callId",
              params: { projectId, callId },
              search: { ...aiCallsSearchOf(place), at: atOf(callId) },
            })
          }
          renderList={(props) =>
            stale(
              <>
                {empty ? (
                  narrow ? (
                    <div className="px-gutter py-5">{guidance}</div>
                  ) : (
                    <p className="px-gutter py-6 text-sm text-ink-subtle">
                      {filtered ? "No call matches these filters." : "No AI calls in this period."}
                    </p>
                  )
                ) : (
                  <CallTable
                    calls={calls}
                    place={place}
                    timeZone={page.timeZone}
                    usersHidden={page.usersHidden}
                    {...props}
                  />
                )}
                {list.hasNextPage && (
                  <Button
                    variant="outline"
                    className="my-4 self-center"
                    onClick={() => void list.fetchNextPage()}
                    disabled={list.isFetchingNextPage}
                  >
                    {list.isFetchingNextPage && (
                      <LoaderCircleIcon
                        aria-hidden="true"
                        className="animate-spin motion-reduce:animate-none"
                      />
                    )}
                    Load older calls
                  </Button>
                )}
              </>,
              list.isPlaceholderData,
            )
          }
          summary={
            empty ? <div className="px-gutter py-5">{guidance}</div> : <CallsSummary first={page} />
          }
          renderDetail={(callId) => {
            const start = atOf(callId);
            return (
              <div className="px-gutter py-5">
                <CallView
                  key={callId}
                  place={place}
                  callId={callId}
                  at={start}
                  inWorkbench
                  actions={
                    <ButtonLink
                      variant="ghost"
                      size="sm"
                      to="/projects/$projectId/ai/calls/$callId"
                      params={{ projectId, callId }}
                      search={{ ...aiCallsSearchOf(place), at: start }}
                    >
                      <ExternalLinkIcon aria-hidden="true" />
                      Open the call&apos;s page
                    </ButtonLink>
                  }
                />
              </div>
            );
          }}
        />
      </div>
    );
  }

  const data = conversations.data;
  if (data === undefined) return null;
  const rows = data.conversations;
  const filtered = narrowed(filters);
  const guidance = (
    <Empty className="border border-dashed p-10">
      <EmptyHeader className="max-w-lg">
        <EmptyMedia variant="icon">
          <MessagesSquareIcon />
        </EmptyMedia>
        <EmptyTitle>
          {filtered ? "No conversation matches these filters" : "No conversations in this period"}
        </EmptyTitle>
        <EmptyDescription>
          {filtered
            ? "Change or clear a filter, or choose a longer period."
            : "Only calls with a conversation ID are in this view. Set the span attribute gen_ai.conversation.id, or conversationId when you send calls over HTTP."}
        </EmptyDescription>
      </EmptyHeader>
      {!filtered && (
        <EmptyContent>
          <DocsButton>How to set it</DocsButton>
        </EmptyContent>
      )}
    </Empty>
  );
  const listed = { ...filters, conversation: undefined };
  const empty = rows.length === 0;
  return (
    <div className="flex flex-col min-[64rem]:h-full min-[64rem]:min-h-0">
      {filterBar}
      <Workbench
        key="conversations"
        label="Conversations"
        className="min-[64rem]:min-h-0 min-[64rem]:flex-1"
        ids={rows.map((row) => row.conversationId)}
        param="conversation"
        filterKey={JSON.stringify([range, environment, listed])}
        onOpenPage={(conversationId) =>
          void navigate({
            to: "/projects/$projectId/ai/conversations/$conversationId",
            params: { projectId, conversationId },
            search: aiCallsSearchOf({ range, environment, filters: listed }),
          })
        }
        renderList={(props) =>
          stale(
            empty ? (
              narrow ? (
                <div className="px-gutter py-5">{guidance}</div>
              ) : (
                <p className="px-gutter py-6 text-sm text-ink-subtle">
                  {filtered
                    ? "No conversation matches these filters."
                    : "No conversations in this period."}
                </p>
              )
            ) : (
              <>
                <ConversationTable
                  conversations={rows}
                  place={{ ...place, filters: listed }}
                  timeZone={data.timeZone}
                  {...props}
                />
                {data.more && (
                  <p className="px-gutter py-4 text-xs text-pretty text-ink-subtle">
                    The {formatWhole(data.limit)} conversations with the latest calls. Choose a
                    shorter period to see older ones.
                  </p>
                )}
              </>
            ),
            conversations.isPlaceholderData,
          )
        }
        summary={
          empty ? (
            <div className="px-gutter py-5">{guidance}</div>
          ) : (
            <ConversationsSummary list={data} />
          )
        }
        renderDetail={(conversationId) => (
          <div className="px-gutter py-5">
            <ConversationView
              key={conversationId}
              place={{ ...place, filters: listed }}
              conversationId={conversationId}
              inWorkbench
              actions={
                <ButtonLink
                  variant="ghost"
                  size="sm"
                  to="/projects/$projectId/ai/conversations/$conversationId"
                  params={{ projectId, conversationId }}
                  search={aiCallsSearchOf({ range, environment, filters: listed })}
                >
                  <ExternalLinkIcon aria-hidden="true" />
                  Open the conversation&apos;s page
                </ButtonLink>
              }
            />
          </div>
        )}
      />
    </div>
  );
}
