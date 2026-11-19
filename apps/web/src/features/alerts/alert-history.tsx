import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { BellOffIcon, OctagonAlertIcon } from "lucide-react";
import * as React from "react";

import { Missing } from "@/components/missing";
import { ScrollHint } from "@/components/scroll-hint";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
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
import { firingQuery, historyQuery, ruleHistoryQuery } from "@/lib/alerts-api";

import { formatMoment } from "../uptime/format";

const HEAD = "h-9 text-xs font-normal text-ink-subtle";

/** A section of the Alerts workbench's panes: a hairline, its heading, a line under it. */
export function PaneSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  const headingId = React.useId();
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3 border-t pt-5">
      <div className="flex flex-col gap-1">
        <h3 id={headingId} className="text-base font-medium text-ink">
          {title}
        </h3>
        {description !== undefined && (
          <p className="text-sm text-pretty text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

/**
 * The alerts firing now, longest first: the project's, or one rule's
 * (`ruleId`), whose list then leaves out the rule's name.
 */
export function FiringSection({ projectId, ruleId }: { projectId: string; ruleId?: string }) {
  const firing = useQuery(firingQuery(projectId));
  const data = firing.data;
  const alerts = (data?.alerts ?? []).filter(
    (alert) => ruleId === undefined || alert.ruleId === ruleId,
  );
  return (
    <PaneSection
      title="Firing now"
      description={
        ruleId === undefined
          ? "Unresolved alerts include checks still down and certificates still near expiry. They also include error spikes, routes, and metrics still beyond their thresholds."
          : "What the rule fires for now, until it is resolved."
      }
    >
      {firing.isError ? (
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertDescription>{firing.error.message}</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={() => void firing.refetch()}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : data === undefined ? (
        <Skeleton className="h-12 w-full" aria-label="Loading" />
      ) : alerts.length === 0 ? (
        <p className="text-sm text-ink-subtle">Nothing is firing.</p>
      ) : (
        <ul className="flex flex-col gap-3" aria-label="Firing now">
          {alerts.map((alert) => (
            <li key={`${alert.ruleId}:${alert.subject}`} className="flex flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-2 text-sm">
                <StatusBadge tone="critical">Firing</StatusBadge>
                <span>
                  <span className="font-medium text-ink">{alert.subjectName}</span>
                  <span className="text-ink-subtle">
                    {ruleId === undefined ? `, rule ${alert.ruleName}` : ""}, since{" "}
                    <time dateTime={alert.since}>{formatMoment(alert.since, data.timeZone)}</time>
                  </span>
                </span>
              </span>
              <span className="text-xs break-words text-ink-subtle">{alert.message}</span>
            </li>
          ))}
        </ul>
      )}
    </PaneSection>
  );
}

/**
 * Alerts, newest first, with whether each went out: the project's, or one
 * rule's (`ruleId`, without the rule's column), 20 at a time.
 */
export function HistorySection({ projectId, ruleId }: { projectId: string; ruleId?: string }) {
  const history = useInfiniteQuery(
    ruleId === undefined ? historyQuery(projectId) : ruleHistoryQuery(projectId, ruleId),
  );
  const pages = history.data?.pages;
  const alerts = pages?.flatMap((page) => page.alerts) ?? [];
  const first = pages?.[0];
  const caption =
    ruleId === undefined ? "Recent alerts, newest first" : "The rule's alerts, newest first";
  return (
    <PaneSection
      title={ruleId === undefined ? "Recent alerts" : "Its alerts"}
      description={`${ruleId === undefined ? "All alerts triggered by the rules" : "The alerts this rule triggered"}, newest first, kept for ${first?.retentionDays ?? 90} days. Alerts suppressed by a rule's hourly limit are listed and marked. No notification is sent for them.`}
    >
      {history.isError ? (
        <Alert variant="destructive">
          <OctagonAlertIcon />
          <AlertDescription>{history.error.message}</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={() => void history.refetch()}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : first === undefined ? (
        <Skeleton className="h-20 w-full" aria-label="Loading" />
      ) : alerts.length === 0 ? (
        <p className="text-sm text-ink-subtle">
          {ruleId === undefined ? "No alert has fired yet." : "This rule has not fired yet."}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <ScrollHint>
            {/* On a phone each alert stacks: when and its rule, then what happened, full width. */}
            <Table className="table-fixed max-sm:block sm:min-w-[32rem]">
              <caption className="sr-only">{caption}</caption>
              <colgroup>
                <col className="w-36" />
                {ruleId === undefined && <col className="w-28" />}
                <col />
                <col className="w-36" />
              </colgroup>
              <TableHeader className="max-sm:sr-only">
                <TableRow className="hover:bg-transparent">
                  <TableHead scope="col" className={`${HEAD} pl-0`}>
                    Fired
                  </TableHead>
                  {ruleId === undefined && (
                    <TableHead scope="col" className={HEAD}>
                      Rule
                    </TableHead>
                  )}
                  <TableHead scope="col" className={HEAD}>
                    What happened
                  </TableHead>
                  <TableHead scope="col" className={`${HEAD} pr-0`}>
                    Resolved
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="max-sm:block">
                {alerts.map((alert) => (
                  <TableRow
                    key={alert.id}
                    className="hover:bg-transparent max-sm:grid max-sm:grid-cols-[auto_minmax(0,1fr)] max-sm:gap-x-3 max-sm:py-2"
                  >
                    <TableCell className="pl-0 align-top whitespace-normal max-sm:p-0 max-sm:text-ink-muted">
                      <time dateTime={alert.firedAt}>
                        {formatMoment(alert.firedAt, first.timeZone)}
                      </time>
                    </TableCell>
                    {ruleId === undefined && (
                      <TableCell className="align-top break-words whitespace-normal max-sm:p-0 max-sm:font-medium">
                        {alert.ruleName}
                      </TableCell>
                    )}
                    <TableCell
                      data-column="message"
                      className="align-top text-sm break-words whitespace-normal max-sm:col-span-2 max-sm:p-0 max-sm:pt-1"
                    >
                      {alert.message}
                      {!alert.notified && (
                        <StatusBadge
                          tone="warning"
                          className="ml-2"
                          icon={<BellOffIcon aria-hidden="true" />}
                        >
                          Held back
                        </StatusBadge>
                      )}
                    </TableCell>
                    {/* The head is hidden on a phone: the cell names itself, from data-label. */}
                    <TableCell
                      data-label="Resolved"
                      className="pr-0 align-top whitespace-normal max-sm:col-span-2 max-sm:p-0 max-sm:pt-1 max-sm:text-xs max-sm:text-ink-subtle max-sm:before:mr-1 max-sm:before:content-[attr(data-label)]"
                    >
                      {alert.resolvedAt === null ? (
                        <Missing label="Not resolved" className="text-ink-subtle" />
                      ) : (
                        <time dateTime={alert.resolvedAt}>
                          {formatMoment(alert.resolvedAt, first.timeZone)}
                        </time>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollHint>
          {history.hasNextPage && (
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              disabled={history.isFetchingNextPage}
              onClick={() => void history.fetchNextPage()}
            >
              Show older alerts
            </Button>
          )}
        </div>
      )}
    </PaneSection>
  );
}
