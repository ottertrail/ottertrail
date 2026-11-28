import { PlusIcon, TargetIcon } from "lucide-react";
import * as React from "react";

import { TruncatedText } from "@/components/truncated-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { goalStepText, MAX_GOALS, type ReportGoal } from "@/lib/goals-api";

import { AddGoalDialog } from "./add-goal-dialog";
import { DeleteGoalDialog } from "./delete-goal-dialog";
import { GoalLink } from "./filter-link";
import { formatConversion, formatWhole } from "./format";
import type { PageSearch } from "./list-rows";
import { useAnalyticsScope } from "./scope";

function AddGoalButton({ atLimit, onClick }: { atLimit: boolean; onClick: () => void }) {
  const reasonId = React.useId();
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {atLimit && (
        <span id={reasonId} className="text-xs text-ink-subtle">
          A project has at most {MAX_GOALS} goals. Delete one to add another.
        </span>
      )}
      <Button
        variant="outline"
        size="sm"
        disabled={atLimit}
        aria-describedby={atLimit ? reasonId : undefined}
        onClick={onClick}
      >
        <PlusIcon aria-hidden="true" />
        Add goal
      </Button>
    </div>
  );
}

const headClass = "h-8 text-xs font-normal text-ink-subtle";
/** On phones, CSS uses data-label for column names. */
const stackCell =
  "max-sm:flex max-sm:justify-between max-sm:px-0 max-sm:py-0.5 max-sm:before:text-ink-subtle max-sm:before:content-[attr(data-label)]";

function GoalTable({
  goals,
  projectId,
  returnFocus,
  canManage,
  search,
  selected,
}: {
  goals: ReportGoal[];
  projectId: string;
  returnFocus: React.RefObject<HTMLHeadingElement | null>;
  canManage: boolean;
  search: PageSearch | undefined;
  selected: string | undefined;
}) {
  return (
    <Table className="table-fixed max-sm:block">
      <caption className="sr-only">Goals, in the order added</caption>
      <TableHeader className="max-sm:sr-only">
        <TableRow className="hover:bg-transparent">
          <TableHead scope="col" className={`${headClass} pl-0`}>
            Goal
          </TableHead>
          <TableHead scope="col" className={`${headClass} w-20 text-right`}>
            Visitors
          </TableHead>
          <TableHead scope="col" className={`${headClass} w-24 text-right`}>
            Conversion
          </TableHead>
          <TableHead scope="col" className={`${headClass} w-20 text-right`}>
            Events
          </TableHead>
          {canManage && (
            <TableHead scope="col" className={`${headClass} w-12 pr-0`}>
              <span className="sr-only">Actions</span>
            </TableHead>
          )}
        </TableRow>
      </TableHeader>
      <TableBody className="max-sm:block">
        {goals.map((goal) => {
          // A shared link's goals come without what they match.
          const reached = goal.step === undefined ? undefined : goalStepText(goal.step);
          return (
            <TableRow
              key={goal.id}
              className="hover:bg-transparent max-sm:flex max-sm:flex-col max-sm:py-2"
            >
              <th
                scope="row"
                className="py-1.5 pr-3 pl-0 text-left align-top font-normal max-sm:block max-sm:pr-0"
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <TruncatedText text={goal.name} className="min-w-0 text-ink" render={<div />}>
                    {search === undefined ? (
                      goal.name
                    ) : (
                      <GoalLink search={search} goal={{ id: goal.id }} name={goal.name} />
                    )}
                  </TruncatedText>
                  {selected === goal.id && (
                    <Badge variant="secondary" className="shrink-0">
                      Selected
                    </Badge>
                  )}
                </div>
                {reached !== undefined && (
                  <TruncatedText
                    text={reached}
                    className="text-xs text-ink-subtle"
                    render={<div />}
                  />
                )}

                <div aria-hidden="true" className="mt-1 h-1.5 max-w-xs">
                  <div
                    className="h-full rounded-r bg-chart-1"
                    style={{ width: `${Math.min(1, Math.max(0, goal.conversionRate)) * 100}%` }}
                  />
                </div>
              </th>
              <TableCell
                data-label="Visitors"
                className={`py-1.5 text-right align-top text-ink tabular-nums ${stackCell}`}
              >
                {formatWhole(goal.visitors)}
              </TableCell>
              <TableCell
                data-label="Conversion"
                className={`py-1.5 text-right align-top text-ink tabular-nums ${stackCell}`}
              >
                {formatConversion(goal.conversionRate)}
              </TableCell>
              <TableCell
                data-label="Events"
                className={`py-1.5 text-right align-top text-ink-subtle tabular-nums ${stackCell}`}
              >
                {formatWhole(goal.events)}
              </TableCell>
              {canManage && (
                <TableCell className="py-0.5 pr-0 text-right align-top max-sm:flex max-sm:justify-end max-sm:px-0">
                  <DeleteGoalDialog projectId={projectId} goal={goal} returnFocus={returnFocus} />
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
 * Adding and deleting require product analytics manage access
 * (docs/access.md). With `search`, each goal's name makes it the page's goal.
 */
export function GoalsCard({
  goals,
  projectId,
  eventNames,
  search,
}: {
  goals: ReportGoal[];
  projectId: string;
  eventNames: readonly string[];
  search?: PageSearch;
}) {
  const selected = search?.goal !== undefined && "id" in search.goal ? search.goal.id : undefined;
  // Only the signed-in dashboard changes goals (docs/access.md): never a shared link.
  const canManage = useAnalyticsScope().dashboard?.canManageGoals ?? false;
  const [adding, setAdding] = React.useState(false);
  // Refetching may remove the trigger, so return focus to the heading.
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const atLimit = goals.length >= MAX_GOALS;
  const add = () => setAdding(true);
  const headingId = React.useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2 border-t pt-5">
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className="text-sm font-medium text-ink outline-none"
        >
          Goals
        </h2>
        {goals.length > 0 && canManage && <AddGoalButton atLimit={atLimit} onClick={add} />}
      </div>
      {goals.length === 0 ? (
        <Empty className="border border-dashed p-6">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TargetIcon />
            </EmptyMedia>
            <EmptyTitle>No goals yet</EmptyTitle>
            <EmptyDescription>Add a page or event to track as a goal.</EmptyDescription>
          </EmptyHeader>
          {canManage && (
            <EmptyContent>
              <AddGoalButton atLimit={false} onClick={add} />
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <>
          <GoalTable
            goals={goals}
            projectId={projectId}
            returnFocus={headingRef}
            canManage={canManage}
            search={search}
            selected={selected}
          />
          <p className="text-xs text-ink-subtle">
            Visitors count once per day. Events count every time.
          </p>
        </>
      )}
      {canManage && (
        <AddGoalDialog
          open={adding}
          onOpenChange={setAdding}
          projectId={projectId}
          eventNames={eventNames}
          returnFocus={headingRef}
        />
      )}
    </section>
  );
}
