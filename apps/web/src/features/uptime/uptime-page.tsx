import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ActivityIcon, ExternalLinkIcon, OctagonAlertIcon, PlusIcon } from "lucide-react";
import * as React from "react";

import { ButtonLink } from "@/components/button-link";
import { FilterBar } from "@/components/filter-bar";
import { Missing } from "@/components/missing";
import { PINNED } from "@/components/pinned-column";
import { ScrollHint } from "@/components/scroll-hint";
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
  Workbench,
  WorkbenchKeyHints,
  type WorkbenchListProps,
  WorkbenchStartHint,
} from "@/components/workbench";
import {
  GUTTER_END,
  GUTTER_START,
  LIST_HEAD,
  ROW_LINK,
  selectOnPlainClick,
  workbenchRow,
} from "@/components/workbench-rows";
import { PHONE, useMediaQuery } from "@/hooks/use-media-query";
import { useSearchParam } from "@/hooks/use-search-param";
import { useAccess } from "@/lib/access";
import type { PageRange } from "@/lib/analytics-api";
import { ApiError } from "@/lib/api";
import { type Check, type CheckList, checksQuery } from "@/lib/uptime-api";

import { NoSuchProject } from "../projects/no-such-project";
import { rangeSearch } from "../telemetry/search";
import { CheckActions } from "./check-actions";
import { CheckFormDialog } from "./check-form-dialog";
import { CheckView } from "./check-page";
import { CAUSE_TEXT, formatMoment, formatMs, formatUptime, intervalText } from "./format";
import { CheckStateBadge } from "./state-badge";

/** The latest run in words: its response time, or why it failed. */
function LatestCell({ check }: { check: Check }) {
  if (check.lastCheckedAt === null) {
    return <span className="text-ink-subtle">Not run yet</span>;
  }
  if (check.lastUp === false && check.lastCause !== null) {
    return (
      <span>
        {CAUSE_TEXT[check.lastCause]}
        {check.lastStatusCode === null ? "" : ` (${check.lastStatusCode})`}
      </span>
    );
  }
  return <span className="tabular-nums">{formatMs(check.lastResponseMs ?? 0)}</span>;
}

/**
 * The checks, by name: what each requests (the name links to the check's
 * own page; in the workbench a plain click selects the row instead), its
 * state in words, its uptime over the last 24 hours, and its quick actions
 * (edit, pause or resume, delete), which act at once.
 */
function CheckTable({
  checks,
  projectId,
  canManage,
  onDeleted,
  selected,
  select,
}: {
  checks: readonly Check[];
  projectId: string;
  canManage: boolean;
  onDeleted: (checkId: string) => void;
} & WorkbenchListProps) {
  const phone = useMediaQuery(PHONE);
  return (
    <Table className="table-fixed">
      <caption className="sr-only">Uptime checks</caption>
      <colgroup>
        <col />
        <col className="w-24" />
        {/* On a phone the check's page has the uptime: the name keeps the room. */}
        {!phone && <col className="w-20" />}
        {canManage && <col className="w-28" />}
      </colgroup>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead scope="col" className={`${LIST_HEAD} ${GUTTER_START}`}>
            Check
          </TableHead>
          <TableHead
            scope="col"
            className={`${LIST_HEAD} ${canManage || !phone ? "" : GUTTER_END}`}
          >
            State
          </TableHead>
          {!phone && (
            <TableHead
              scope="col"
              className={`${LIST_HEAD} text-right ${canManage ? "" : GUTTER_END}`}
            >
              24 hours
            </TableHead>
          )}
          {canManage && (
            <TableHead scope="col" className={GUTTER_END}>
              <span className="sr-only">Actions</span>
            </TableHead>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {checks.map((check) => {
          const chosen = check.id === selected;
          return (
            <TableRow key={check.id} {...workbenchRow(check.id, chosen)}>
              <TableCell className={`${GUTTER_START} py-2.5`}>
                <TruncatedText
                  text={check.name}
                  className="rounded-sm text-link hover:underline"
                  render={
                    <Link
                      to="/projects/$projectId/uptime/$checkId"
                      params={{ projectId, checkId: check.id }}
                      aria-current={chosen ? "true" : undefined}
                      {...ROW_LINK}
                      onClick={selectOnPlainClick(select, check.id)}
                    />
                  }
                />
                <TruncatedText
                  text={`${check.method} ${check.url}, ${intervalText(check.intervalSeconds).toLowerCase()}`}
                  className="text-xs text-ink-subtle"
                />
              </TableCell>
              <TableCell className={`py-2.5 ${canManage || !phone ? "" : GUTTER_END}`}>
                <CheckStateBadge check={check} />
              </TableCell>
              {!phone && (
                <TableCell
                  className={`py-2.5 text-right tabular-nums ${canManage ? "" : GUTTER_END}`}
                >
                  {formatUptime(check.uptime.day)}
                </TableCell>
              )}
              {canManage && (
                <TableCell className={`py-2.5 ${GUTTER_END}`}>
                  <CheckActions
                    projectId={projectId}
                    check={check}
                    compact
                    onDeleted={() => onDeleted(check.id)}
                  />
                </TableCell>
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/**
 * With nothing selected, the detail pane sums up every check (the API lists
 * them all): how many are up, down, paused, and not known yet, then each
 * one's uptime over fixed windows, its latest run, and when it last ran. On a
 * narrow screen it follows the list, so checks can still be compared.
 */
function Summary({
  data,
  projectId,
  underList = false,
}: {
  data: CheckList;
  projectId: string;
  /** Under the list on a narrow screen, where no item is chosen beside it. */
  underList?: boolean;
}) {
  const count = (test: (check: Check) => boolean) => data.checks.filter(test).length;
  const pending = count((check) => !check.paused && check.state === "pending");
  const stats: Stat[] = [
    { label: "Checks", value: `${data.checks.length} of ${data.maxChecks}` },
    { label: "Up", value: String(count((check) => !check.paused && check.state === "up")) },
    { label: "Down", value: String(count((check) => !check.paused && check.state === "down")) },
    { label: "Paused", value: String(count((check) => check.paused)) },
    ...(pending > 0 ? [{ label: "Pending", value: String(pending) }] : []),
  ];
  const headingId = React.useId();
  return (
    <div className="flex flex-col gap-6 px-gutter py-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold text-ink">Checks now</h2>
        <p className="text-sm text-ink-subtle">Times in {data.timeZone}.</p>
      </div>
      <section aria-label="Every check" className="flex flex-col gap-3 border-t pt-5">
        <StatStrip label="Checks by state" stats={stats} />
        <p className="text-xs text-pretty text-ink-subtle">
          The project has at most {data.maxChecks} checks.
          {pending > 0 && " Pending checks have not run enough to say whether they are up."}
        </p>
      </section>
      <section aria-labelledby={headingId} className="flex flex-col gap-3 border-t pt-5">
        <div className="flex flex-col gap-1">
          <h3 id={headingId} className="text-base font-medium text-ink">
            Uptime
          </h3>
          <p className="text-sm text-muted-foreground">
            Uptime is the share of the time not inside an incident. Then each check&apos;s latest
            run, and when it last ran.
          </p>
        </div>
        <ScrollHint>
          <Table className="min-w-[34rem] table-fixed">
            <caption className="sr-only">Uptime of each check</caption>
            <colgroup>
              <col />
              <col className="w-20" />
              <col className="w-20" />
              <col className="w-20" />
              <col className="w-32" />
              <col className="w-32" />
            </colgroup>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col" className={`${LIST_HEAD} pl-0 ${PINNED}`}>
                  Check
                </TableHead>
                <TableHead scope="col" className={`${LIST_HEAD} text-right`}>
                  24 hours
                </TableHead>
                <TableHead scope="col" className={`${LIST_HEAD} text-right`}>
                  7 days
                </TableHead>
                <TableHead scope="col" className={`${LIST_HEAD} text-right`}>
                  30 days
                </TableHead>
                <TableHead scope="col" className={LIST_HEAD}>
                  Latest
                </TableHead>
                <TableHead scope="col" className={`${LIST_HEAD} pr-0`}>
                  Last checked
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.checks.map((check) => (
                <TableRow key={check.id} className="hover:bg-transparent">
                  <th
                    scope="row"
                    className={`py-1.5 pr-3 text-left align-top font-normal ${PINNED}`}
                  >
                    {underList ? (
                      // No pane beside the list: the name opens the check's page.
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
                    ) : (
                      <TruncatedText
                        text={check.name}
                        className="text-link hover:underline"
                        render={
                          <Link
                            to="/projects/$projectId/uptime"
                            params={{ projectId }}
                            search={(previous) => ({ ...previous, check: check.id })}
                          />
                        }
                      />
                    )}
                  </th>
                  <TableCell className="py-1.5 text-right align-top tabular-nums">
                    {formatUptime(check.uptime.day)}
                  </TableCell>
                  <TableCell className="py-1.5 text-right align-top tabular-nums">
                    {formatUptime(check.uptime.week)}
                  </TableCell>
                  <TableCell className="py-1.5 text-right align-top tabular-nums">
                    {formatUptime(check.uptime.month)}
                  </TableCell>
                  <TableCell className="py-1.5 align-top whitespace-normal">
                    <LatestCell check={check} />
                  </TableCell>
                  <TableCell className="py-1.5 pr-0 align-top whitespace-normal">
                    {check.lastCheckedAt === null ? (
                      <Missing label="Not checked yet" className="text-ink-subtle" />
                    ) : (
                      <time dateTime={check.lastCheckedAt}>
                        {formatMoment(check.lastCheckedAt, data.timeZone)}
                      </time>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollHint>
      </section>
      {!underList && <WorkbenchStartHint noun="a check" />}
    </div>
  );
}

/**
 * The project's uptime checks as a workbench (docs/design-system.md,
 * "Workbench"): each with its state in words and its uptime over the last
 * 24 hours, with edit, pause or resume, and delete on the row; beside the
 * selected check's detail (for the period in the address) or, with none
 * selected, every check's uptime. Under 64rem a row opens the check's own
 * page.
 */
export function UptimePage({ projectId, range }: { projectId: string; range: PageRange }) {
  const navigate = useNavigate();
  const list = useQuery(checksQuery(projectId));
  const [adding, setAdding] = React.useState(false);
  const [selected, setSelected] = useSearchParam("check");
  const canManage = useAccess().canUse("uptime_alerts", "manage");
  // The Workbench keeps the latest of this, so it may be a new function each render.
  const openPage = (checkId: string) =>
    void navigate({
      to: "/projects/$projectId/uptime/$checkId",
      params: { projectId, checkId },
      search: rangeSearch(range),
    });

  if (list.error instanceof ApiError && list.error.status === 404) {
    return <NoSuchProject />;
  }
  const data = list.data;
  // A deleted check that was selected gives way to the one after it (or before, at the end).
  const afterDelete = (checkId: string) => {
    if (checkId !== selected) return;
    const ids = (data?.checks ?? []).map((check) => check.id);
    const at = ids.indexOf(checkId);
    setSelected(ids[at + 1] ?? (at > 0 ? ids[at - 1] : undefined), { replace: true });
  };
  const full = data !== undefined && data.checks.length >= data.maxChecks;
  const addButton = canManage && (
    <Button onClick={() => setAdding(true)} disabled={full}>
      <PlusIcon aria-hidden="true" />
      Add check
    </Button>
  );
  const dialog = <CheckFormDialog open={adding} onOpenChange={setAdding} projectId={projectId} />;
  const failure = list.isError && (
    <Alert variant="destructive">
      <OctagonAlertIcon />
      <AlertTitle>
        {data === undefined ? "The checks could not load" : "The checks could not refresh"}
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
  );

  if (data === undefined || data.checks.length === 0) {
    return (
      <div className="flex flex-col gap-6 px-gutter py-5">
        {data === undefined ? (
          list.isError ? (
            failure
          ) : (
            <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          )
        ) : (
          <Empty className="border border-dashed p-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ActivityIcon />
              </EmptyMedia>
              <EmptyTitle>No uptime checks yet</EmptyTitle>
              <EmptyDescription>
                This instance requests your site or API URL on a schedule. The check is marked down
                when it fails. You can see when the URL stopped responding and for how long.
              </EmptyDescription>
            </EmptyHeader>
            {canManage && <EmptyContent>{addButton}</EmptyContent>}
          </Empty>
        )}
        {dialog}
      </div>
    );
  }

  return (
    <div className="flex flex-col min-[64rem]:h-full min-[64rem]:min-h-0">
      <FilterBar
        label="Checks"
        filters={
          <p className="text-sm text-ink-subtle">
            {data.checks.length} of at most {data.maxChecks} checks
          </p>
        }
        actions={
          <>
            <WorkbenchKeyHints />
            {addButton}
          </>
        }
      />
      <Workbench
        label="Uptime"
        className="min-[64rem]:min-h-0 min-[64rem]:flex-1"
        ids={data.checks.map((check) => check.id)}
        param="check"
        onOpenPage={openPage}
        renderList={(props) => (
          <div className="flex flex-col">
            {list.isError && <div className="px-gutter pt-4">{failure}</div>}
            <CheckTable
              checks={data.checks}
              projectId={projectId}
              canManage={canManage}
              onDeleted={afterDelete}
              {...props}
            />
            {full && (
              <p className="px-gutter py-4 text-sm text-ink-subtle">
                The project reached its check limit. Delete a check to add another.
              </p>
            )}
          </div>
        )}
        summary={<Summary data={data} projectId={projectId} />}
        narrowFooter={<Summary data={data} projectId={projectId} underList />}
        renderDetail={(checkId) => (
          <div className="px-gutter py-5">
            <CheckView
              key={checkId}
              projectId={projectId}
              checkId={checkId}
              range={range}
              inWorkbench
              onRange={(next) =>
                void navigate({
                  to: "/projects/$projectId/uptime",
                  params: { projectId },
                  search: { ...rangeSearch(next), check: checkId },
                })
              }
              onDeleted={() => afterDelete(checkId)}
              actions={
                <ButtonLink
                  variant="ghost"
                  size="sm"
                  to="/projects/$projectId/uptime/$checkId"
                  params={{ projectId, checkId }}
                  search={rangeSearch(range)}
                >
                  <ExternalLinkIcon aria-hidden="true" />
                  Open the check&apos;s page
                </ButtonLink>
              }
            />
          </div>
        )}
      />
      {dialog}
    </div>
  );
}
