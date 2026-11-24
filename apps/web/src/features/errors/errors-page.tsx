import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  BugIcon,
  CircleCheckIcon,
  ExternalLinkIcon,
  InfoIcon,
  OctagonAlertIcon,
} from "lucide-react";
import * as React from "react";

import { ButtonLink } from "@/components/button-link";
import { CopyableCode } from "@/components/copyable-code";
import { FilterBar, FilterBarRange } from "@/components/filter-bar";
import { type Stat, StatStrip } from "@/components/stat-strip";
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
import { Kbd } from "@/components/ui/kbd";
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
import { WhenAllowed } from "@/components/when-allowed";
import {
  Workbench,
  type WorkbenchAction,
  WorkbenchKeyHints,
  type WorkbenchListProps,
} from "@/components/workbench";
import {
  GUTTER_END,
  GUTTER_START,
  LIST_HEAD,
  ROW_LINK,
  selectOnPlainClick,
  workbenchRow,
} from "@/components/workbench-rows";
import { NARROW_WORKBENCH, useMediaQuery } from "@/hooks/use-media-query";
import { useAccess } from "@/lib/access";
import { DEFAULT_ENVIRONMENT, type PageRange } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import {
  ASSIGNEE_FILTERS,
  type AssigneeFilter,
  DEFAULT_ASSIGNEE_FILTER,
  type ErrorGroup,
  type ErrorList,
  errorsQuery,
  isAssigneeFilter,
  isStatusFilter,
  STATUS_FILTERS,
  type StatusFilter,
} from "@/lib/errors-api";

import { formatWhole } from "../analytics/format";
import { dayIn } from "../overview/format";
import { NoSuchProject } from "../projects/no-such-project";
import { formatDay, formatMoment, timeAgo } from "../users/format";
import { AssigneeMark } from "./assignee";
import { ErrorView } from "./error-page";
import { ErrorStatusBadge } from "./error-status";
import { EnvironmentSelect, PeriodSelect } from "./range-controls";
import { type ErrorsSearch, errorsSearchOf } from "./search";

const CAPTURE_EXAMPLE = `try {
  await saveOrder(order);
} catch (error) {
  window.ottertrail?.captureError(error);
}`;

const TOP_ERRORS = 5;

const EMPTY_LIST: Record<StatusFilter, string> = {
  unresolved: "Nothing unresolved in this period.",
  resolved: "Nothing resolved in this period.",
  all: "Nothing in this period.",
};

const EMPTY_TITLES: Record<StatusFilter, string> = {
  unresolved: "No unresolved errors in this period",
  resolved: "No resolved errors in this period",
  all: "No errors in this period",
};

const EMPTY_ASSIGNED: Record<Exclude<AssigneeFilter, "everyone">, string> = {
  me: "No errors assigned to you in this period",
  none: "No unassigned errors in this period",
};

function NoErrors({
  status,
  environment,
  assignee = DEFAULT_ASSIGNEE_FILTER,
}: {
  status: StatusFilter;
  environment: string;
  assignee?: AssigneeFilter;
}) {
  const where = environment === DEFAULT_ENVIRONMENT ? "" : ` in ${environment}`;
  if (assignee !== "everyone") {
    return (
      <Empty className="border border-dashed p-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BugIcon />
          </EmptyMedia>
          <EmptyTitle>{EMPTY_ASSIGNED[assignee]}</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }
  if (status === "unresolved") {
    return (
      <Empty className="border border-dashed p-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BugIcon />
          </EmptyMedia>
          <EmptyTitle>{EMPTY_TITLES.unresolved}</EmptyTitle>
          <EmptyDescription>
            The tracking snippet reports uncaught errors and unhandled promise rejections{where} on
            its own. To report an error your code catches, call{" "}
            <code className="font-mono">window.ottertrail.captureError(error)</code>. To turn the
            automatic reports off, add{" "}
            <code className="font-mono">data-errors=&quot;off&quot;</code> to the snippet.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="max-w-2xl text-left">
          <CopyableCode text={CAPTURE_EXAMPLE} copyLabel="Copy the example" />
        </EmptyContent>
      </Empty>
    );
  }
  return (
    <Empty className="border border-dashed p-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          {status === "resolved" ? <CircleCheckIcon /> : <BugIcon />}
        </EmptyMedia>
        <EmptyTitle>{EMPTY_TITLES[status]}</EmptyTitle>
        <EmptyDescription>
          {status === "resolved"
            ? "Errors you mark resolved remain here until they occur again."
            : `No error arrived${where} in this period. Choose a longer one to see earlier errors.`}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/** The page when the project has no error at all: how errors arrive, as the Traces page says how traces do. */
function NoErrorsYet({ projectId }: { projectId: string }) {
  return (
    <Empty className="border border-dashed p-10">
      <EmptyHeader className="max-w-xl">
        <EmptyMedia variant="icon">
          <BugIcon />
        </EmptyMedia>
        <EmptyTitle>No errors yet</EmptyTitle>
        <EmptyDescription>
          The tracking snippet reports uncaught errors and unhandled promise rejections on its own.
          Your servers&apos; exceptions arrive with their traces and logs over OpenTelemetry. To
          report an error your code catches, call{" "}
          <code className="font-mono">window.ottertrail.captureError(error)</code>.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="max-w-2xl text-left">
        <CopyableCode text={CAPTURE_EXAMPLE} copyLabel="Copy the example" />
        <p className="text-sm text-ink-subtle">
          To turn the automatic reports off, add{" "}
          <code className="font-mono">data-errors=&quot;off&quot;</code> to the snippet.
        </p>
        <WhenAllowed permission="projects">
          <ButtonLink
            variant="outline"
            className="self-center"
            to="/projects/$projectId/settings"
            params={{ projectId }}
            search={{ tab: "install" }}
          >
            Project settings
          </ButtonLink>
        </WhenAllowed>
      </EmptyContent>
    </Empty>
  );
}

const headClass = LIST_HEAD;
const gutterStart = GUTTER_START;
const gutterEnd = GUTTER_END;

/** Keep API order so the 1,000-group limit retains the latest groups. */
function ErrorTable({
  list,
  projectId,
  search,
  selected,
  select,
}: {
  list: ErrorList;
  projectId: string;
  search: ErrorsSearch;
} & WorkbenchListProps) {
  const detailSearch = errorsSearchOf({ range: search.range, environment: search.environment });
  return (
    <Table className="table-fixed">
      <caption className="sr-only">Errors, most recently seen first</caption>
      <colgroup>
        <col />
        <col className="w-24" />
        <col className="w-16" />
        <col className="w-20" />
      </colgroup>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead scope="col" className={`${headClass} ${gutterStart}`}>
            Error
          </TableHead>
          <TableHead scope="col" className={`${headClass} text-right`}>
            Occurrences
          </TableHead>
          <TableHead
            scope="col"
            className={`${headClass} text-right`}
            title="Known users: your site's user IDs"
          >
            Users
          </TableHead>
          <TableHead scope="col" className={`${headClass} text-right ${gutterEnd}`}>
            Visitors
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {list.groups.map((group) => {
          const chosen = group.fingerprint === selected;
          return (
            <TableRow key={group.fingerprint} {...workbenchRow(group.fingerprint, chosen)}>
              <TableCell className={`${gutterStart} py-2.5 align-top whitespace-normal`}>
                <TruncatedText
                  text={`${group.type}${group.message === "" ? "" : `: ${group.message}`}`}
                  className="line-clamp-2 rounded-sm break-words text-link hover:underline"
                  render={
                    <Link
                      to="/projects/$projectId/errors/$fingerprint"
                      params={{ projectId, fingerprint: group.fingerprint }}
                      search={detailSearch}
                      aria-current={chosen ? "true" : undefined}
                      {...ROW_LINK}
                      onClick={selectOnPlainClick(select, group.fingerprint)}
                    />
                  }
                >
                  <span className="font-medium">{group.type}</span>
                  {group.message !== "" && <span>: {group.message}</span>}
                </TruncatedText>
                <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-subtle">
                  {group.status !== "unresolved" && <ErrorStatusBadge status={group.status} />}
                  {group.assignee !== null && <AssigneeMark assignee={group.assignee} />}
                  <span>
                    Last seen{" "}
                    <time
                      dateTime={group.lastSeen}
                      title={formatMoment(group.lastSeen, list.timeZone)}
                    >
                      {timeAgo(new Date(group.lastSeen))}
                    </time>
                  </span>
                  <span>First seen {formatDay(group.firstSeen, list.timeZone)}</span>
                </p>
              </TableCell>
              <TableCell className="py-2.5 text-right align-top tabular-nums">
                {formatWhole(group.occurrences)}
              </TableCell>
              <TableCell className="py-2.5 text-right align-top tabular-nums">
                {formatWhole(group.users)}
              </TableCell>
              <TableCell className={`py-2.5 text-right align-top tabular-nums ${gutterEnd}`}>
                {formatWhole(group.visitors)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

const isNew = (group: ErrorGroup, list: ErrorList) =>
  dayIn(list.timeZone, new Date(group.firstSeen)) >= list.firstDay;

function Summary({
  list,
  status,
  projectId,
}: {
  list: ErrorList;
  status: StatusFilter;
  projectId: string;
}) {
  const open = list.groups.filter((group) => group.status !== "resolved");
  // A list capped at 1,000 gives lower bounds for counts.
  const count = (n: number) => (list.truncated ? `${formatWhole(n)}+` : formatWhole(n));
  const newStat: Stat = {
    label: "New",
    value: count(list.groups.filter((group) => isNew(group, list)).length),
  };
  // Count only listed groups; a resolved-only list has no unresolved groups.
  const stats: Stat[] =
    status === "resolved"
      ? [{ label: "Resolved", value: count(list.groups.length) }, newStat]
      : [
          { label: "Unresolved", value: count(open.length) },
          newStat,
          {
            label: "Regressed",
            value: count(list.groups.filter((group) => group.status === "regressed").length),
          },
          ...(status === "all"
            ? [{ label: "Resolved", value: count(list.groups.length - open.length) }]
            : []),
        ];
  const ranked = (open.length > 0 ? open : list.groups)
    .toSorted((a, b) => b.users - a.users || b.occurrences - a.occurrences)
    .slice(0, TOP_ERRORS);
  const which = open.length > 0 ? "Unresolved errors" : "Resolved errors";
  const headingId = React.useId();
  return (
    <div className="flex flex-col gap-6 px-gutter py-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold text-ink">This period</h2>
        <FilterBarRange firstDay={list.firstDay} lastDay={list.lastDay} timeZone={list.timeZone} />
      </div>
      <section
        aria-label="Error groups in this period"
        className="flex flex-col gap-3 border-t pt-5"
      >
        <StatStrip label="Error groups" stats={stats} />
        <p className="text-xs text-pretty text-ink-subtle">
          {list.truncated &&
            "More than 1,000 error groups in this period: these figures count the 1,000 seen most recently, so each is at least that many. "}
          Error groups in the list.{status === "resolved" ? "" : " Unresolved includes regressed."}{" "}
          New groups were first seen in this period.
          {status === "resolved"
            ? ""
            : " Regressed groups occurred again after they were resolved."}
        </p>
      </section>
      <section aria-labelledby={headingId} className="flex flex-col gap-3 border-t pt-5">
        <div className="flex flex-col gap-1">
          <h3 id={headingId} className="text-base font-medium text-ink">
            Most users affected
          </h3>
          <p className="text-sm text-muted-foreground">
            {which}, most known users first
            {list.truncated ? ", among the 1,000 seen most recently." : "."}
            {ranked.length < TOP_ERRORS &&
              ` ${ranked.length === 1 ? "Only 1 is" : `Only ${ranked.length} are`} listed in this period.`}
          </p>
        </div>
        <Table className="table-fixed">
          <caption className="sr-only">{which}, most users first</caption>
          <colgroup>
            <col />
            <col className="w-16" />
            <col className="w-28" />
          </colgroup>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead scope="col" className={`${headClass} pl-0`}>
                Error
              </TableHead>
              <TableHead scope="col" className={`${headClass} text-right`}>
                Users
              </TableHead>
              <TableHead scope="col" className={`${headClass} pr-0 text-right`}>
                Occurrences
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ranked.map((group) => (
              <TableRow key={group.fingerprint} className="hover:bg-transparent">
                <th scope="row" className="py-1.5 pr-3 text-left align-top font-normal">
                  <TruncatedText
                    text={group.type}
                    className="font-medium text-link hover:underline"
                    render={
                      <Link
                        to="/projects/$projectId/errors"
                        params={{ projectId }}
                        search={(previous) => ({ ...previous, error: group.fingerprint })}
                      />
                    }
                  />
                  {group.message !== "" && (
                    <TruncatedText
                      text={group.message}
                      className="text-ink-muted"
                      render={<div />}
                    />
                  )}
                </th>
                <TableCell className="py-1.5 text-right align-top tabular-nums">
                  {formatWhole(group.users)}
                </TableCell>
                <TableCell className="py-1.5 pr-0 text-right align-top tabular-nums">
                  {formatWhole(group.occurrences)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
      <p className="border-t pt-5 text-sm text-ink-muted">
        Select an error, or press <Kbd>j</Kbd> to start at the top.
      </p>
    </div>
  );
}

function LoadingList() {
  return (
    <div className="flex flex-col gap-2 px-gutter py-4" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-12 w-full" />
    </div>
  );
}

/** Counts cover the period; first and last seen cover all time (docs/design-system.md, "Workbench"). */
export function ErrorsPage({
  projectId,
  range,
  environment = DEFAULT_ENVIRONMENT,
  status,
  assignee = DEFAULT_ASSIGNEE_FILTER,
}: {
  projectId: string;
  range: PageRange;
  environment?: string;
  status: StatusFilter;
  assignee?: AssigneeFilter;
}) {
  const navigate = useNavigate();
  const query = useQuery(errorsQuery(projectId, range, environment, status, assignee));
  const search: ErrorsSearch = { range, environment, status, assignee };
  const narrow = useMediaQuery(NARROW_WORKBENCH);
  const resolveRef = React.useRef<HTMLButtonElement>(null);
  const canChange = useAccess().canUse("errors", "manage");
  const action = React.useMemo<WorkbenchAction | undefined>(
    () =>
      canChange
        ? { key: "e", label: "resolve or reopen", onAction: () => resolveRef.current?.click() }
        : undefined,
    [canChange],
  );
  const show = (next: Partial<ErrorsSearch>) =>
    void navigate({
      to: "/projects/$projectId/errors",
      params: { projectId },
      search: errorsSearchOf({ ...search, ...next }),
    });
  const detailSearch = errorsSearchOf({ range, environment });
  // Workbench keeps the latest callback; it need not be stable.
  const openPage = (fingerprint: string) =>
    void navigate({
      to: "/projects/$projectId/errors/$fingerprint",
      params: { projectId, fingerprint },
      search: detailSearch,
    });

  if (query.error instanceof ApiError && query.error.status === 404) {
    return <NoSuchProject />;
  }
  const data = query.data;

  const filterBar = (
    <FilterBar
      label="Period, environment, status, and assignee"
      period={
        <PeriodSelect range={range} answered={data} onRange={(next) => show({ range: next })} />
      }
      environment={
        <EnvironmentSelect
          environment={environment}
          answered={data}
          onEnvironment={(next) => show({ environment: next })}
        />
      }
      filters={
        // Status and assignee mean nothing until the project has an error.
        data?.received !== false && (
          <>
            <ToggleGroup
              value={[status]}
              onValueChange={(value) => {
                const [next] = value;
                if (isStatusFilter(next)) show({ status: next });
              }}
              aria-label="Status"
              variant="outline"
              size="sm"
              spacing={0}
            >
              {STATUS_FILTERS.map((item) => (
                <ToggleGroupItem key={item.value} value={item.value}>
                  {item.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <ToggleGroup
              value={[assignee]}
              onValueChange={(value) => {
                const [next] = value;
                if (isAssigneeFilter(next)) show({ assignee: next });
              }}
              aria-label="Assignee"
              variant="outline"
              size="sm"
              spacing={0}
            >
              {ASSIGNEE_FILTERS.map((item) => (
                <ToggleGroupItem key={item.value} value={item.value}>
                  {item.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </>
        )
      }
      range={
        data !== undefined && (
          <FilterBarRange
            firstDay={data.firstDay}
            lastDay={data.lastDay}
            timeZone={data.timeZone}
          />
        )
      }
      actions={data?.received !== false && <WorkbenchKeyHints action={action} />}
    />
  );

  const failure = query.isError && (
    <Alert variant="destructive">
      <OctagonAlertIcon />
      <AlertTitle>
        {data === undefined ? "The errors could not load" : "The errors could not refresh"}
      </AlertTitle>
      <AlertDescription>
        {query.error.message}
        {data !== undefined && " The list below is from the last successful load."}
      </AlertDescription>
      <AlertAction>
        <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </AlertAction>
    </Alert>
  );

  if (data === undefined) {
    return (
      <div className="flex flex-col">
        {filterBar}
        {query.isError ? <div className="px-gutter py-5">{failure}</div> : <LoadingList />}
      </div>
    );
  }

  if (!data.received) {
    return (
      <div className="flex flex-col">
        {filterBar}
        <div className="flex flex-col gap-3 px-gutter py-5">
          {failure}
          <NoErrorsYet projectId={projectId} />
        </div>
      </div>
    );
  }

  const empty = data.groups.length === 0;
  return (
    <div className="flex flex-col min-[64rem]:h-full min-[64rem]:min-h-0">
      {filterBar}
      <Workbench
        label="Errors"
        className="min-[64rem]:min-h-0 min-[64rem]:flex-1"
        ids={data.groups.map((group) => group.fingerprint)}
        param="error"
        action={action}
        onOpenPage={openPage}
        renderList={(props) => (
          <div
            className="flex flex-col transition-opacity data-[stale=true]:opacity-60"
            data-stale={query.isPlaceholderData}
            aria-busy={query.isPlaceholderData}
          >
            {(query.isError || data.truncated) && (
              <div className="flex flex-col gap-3 px-gutter pt-4">
                {failure}
                {data.truncated && (
                  <Alert>
                    <InfoIcon />
                    <AlertTitle>More than 1,000 errors in this period</AlertTitle>
                    <AlertDescription>
                      Only the 1,000 seen most recently are listed. Choose a shorter period to see
                      the others.
                    </AlertDescription>
                  </Alert>
                )}
              </div>
            )}
            {empty ? (
              narrow ? (
                <div className="px-gutter py-5">
                  <NoErrors status={status} environment={environment} assignee={assignee} />
                </div>
              ) : (
                <p className="px-gutter py-6 text-sm text-ink-subtle">
                  {assignee === "everyone" ? EMPTY_LIST[status] : `${EMPTY_ASSIGNED[assignee]}.`}
                </p>
              )
            ) : (
              <ErrorTable list={data} projectId={projectId} search={search} {...props} />
            )}
          </div>
        )}
        summary={
          empty ? (
            <div className="px-gutter py-5">
              <NoErrors status={status} environment={environment} assignee={assignee} />
            </div>
          ) : (
            <Summary list={data} status={status} projectId={projectId} />
          )
        }
        renderDetail={(fingerprint) => (
          <div className="px-gutter py-5">
            <ErrorView
              key={fingerprint}
              projectId={projectId}
              fingerprint={fingerprint}
              range={range}
              environment={environment}
              resolveRef={resolveRef}
              actions={
                <ButtonLink
                  variant="ghost"
                  size="sm"
                  to="/projects/$projectId/errors/$fingerprint"
                  params={{ projectId, fingerprint }}
                  search={detailSearch}
                >
                  <ExternalLinkIcon aria-hidden="true" />
                  Open the error&apos;s page
                </ButtonLink>
              }
            />
          </div>
        )}
      />
    </div>
  );
}
