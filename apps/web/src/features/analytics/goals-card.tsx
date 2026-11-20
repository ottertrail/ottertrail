import { PlusIcon, TargetIcon } from "lucide-react";
import * as React from "react";

import { TruncatedText } from "@/components/truncated-text";
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
import { useAccess } from "@/lib/access";
import { type GoalResult, goalStepText, MAX_GOALS } from "@/lib/goals-api";

import { AddGoalDialog } from "./add-goal-dialog";
import { DeleteGoalDialog } from "./delete-goal-dialog";
import { formatConversion, formatWhole } from "./format";

/** "Add goal", or, at the limit, the same button disabled with the reason beside it. */
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
/**
 * On a phone each goal stacks into a block: its name, then each figure after
 * its column's name, which CSS draws from `data-label` so the cell's text
 * stays the figure.
 */
const stackCell =
  "max-sm:flex max-sm:justify-between max-sm:px-0 max-sm:py-0.5 max-sm:before:text-ink-subtle max-sm:before:content-[attr(data-label)]";

/**
 * The goals in the order added: name, what reaches it, visitors who did, their
 * share of the page's visitors, and how often it happened. The bar shows the
 * share, from 0 to 100%.
 */
function GoalTable({
  goals,
  projectId,
  returnFocus,
  canManage,
}: {
  goals: GoalResult[];
  projectId: string;
  returnFocus: React.RefObject<HTMLHeadingElement | null>;
  /** Whether the user may delete goals (product analytics, manage). */
  canManage: boolean;
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
          const reached = goalStepText(goal.step);
          return (
            <TableRow
              key={goal.id}
              className="hover:bg-transparent max-sm:flex max-sm:flex-col max-sm:py-2"
            >
              <th
                scope="row"
                className="py-1.5 pr-3 pl-0 text-left align-top font-normal max-sm:block max-sm:pr-0"
              >
                <TruncatedText text={goal.name} className="text-ink" render={<div />} />
                <TruncatedText
                  text={reached}
                  className="text-xs text-ink-subtle"
                  render={<div />}
                />

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
 * The project's saved goals, counted in the page's period, environment, and
 * filters, as the rest of the page. Adding and deleting one refetches the
 * page; both need product analytics at manage (docs/access.md).
 */
export function GoalsCard({
  goals,
  projectId,
  eventNames,
}: {
  goals: GoalResult[];
  projectId: string;
  /** The page's custom events, offered when an event goal is added. */
  eventNames: readonly string[];
}) {
  const canManage = useAccess().canUse("product_analytics", "manage");
  const [adding, setAdding] = React.useState(false);
  // Where focus goes when a dialog closes: the button that opened it may be
  // gone once the list refetches (the empty state's, or a deleted row's).
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
            <EmptyDescription>
              A goal is a page or event that counts as a success, such as viewing /pricing or
              signing up. Each goal shows the number and share of visitors who reached it.
            </EmptyDescription>
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
          />
          <p className="text-xs text-ink-subtle">
            Visitor counts and shares for each goal use this page's period, environment, and
            filters. Visitors count per day, as in the summary. Events count every time.
          </p>
        </>
      )}
      <AddGoalDialog
        open={adding}
        onOpenChange={setAdding}
        projectId={projectId}
        eventNames={eventNames}
        returnFocus={headingRef}
      />
    </section>
  );
}
