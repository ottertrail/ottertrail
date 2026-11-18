import { PlusIcon, TargetIcon } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
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
    <table className="w-full table-fixed text-sm">
      <caption className="sr-only">Goals, in the order added</caption>
      <thead>
        <tr className="text-xs text-ink-subtle">
          <th scope="col" className="pb-2 text-left font-normal">
            Goal
          </th>
          <th scope="col" className="w-18 pb-2 text-right font-normal">
            Visitors
          </th>
          <th scope="col" className="w-22 pb-2 text-right font-normal">
            Conversion
          </th>
          <th scope="col" className="w-16 pb-2 text-right font-normal">
            Events
          </th>
          {canManage && (
            <th scope="col" className="w-10 pb-2">
              <span className="sr-only">Actions</span>
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {goals.map((goal) => {
          const reached = goalStepText(goal.step);
          return (
            <tr key={goal.id}>
              <th scope="row" className="py-1.5 pr-3 text-left align-top font-normal">
                <div className="truncate text-ink" title={goal.name}>
                  {goal.name}
                </div>
                <div className="truncate text-xs text-ink-subtle" title={reached}>
                  {reached}
                </div>
                <div
                  aria-hidden="true"
                  className="mt-1 h-1.5 rounded-r bg-chart-1"
                  style={{ width: `${Math.min(1, Math.max(0, goal.conversionRate)) * 100}%` }}
                />
              </th>
              <td className="py-1.5 text-right align-top text-ink tabular-nums">
                {formatWhole(goal.visitors)}
              </td>
              <td className="py-1.5 text-right align-top text-ink tabular-nums">
                {formatConversion(goal.conversionRate)}
              </td>
              <td className="py-1.5 text-right align-top text-ink-subtle tabular-nums">
                {formatWhole(goal.events)}
              </td>
              {canManage && (
                <td className="py-0.5 text-right align-top">
                  <DeleteGoalDialog projectId={projectId} goal={goal} returnFocus={returnFocus} />
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
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
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3 ref={headingRef} tabIndex={-1} className="outline-none">
            Goals
          </h3>
        </CardTitle>
        {goals.length > 0 && canManage && (
          <CardAction>
            <AddGoalButton atLimit={atLimit} onClick={add} />
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {goals.length === 0 ? (
          <Empty className="p-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <TargetIcon />
              </EmptyMedia>
              <EmptyTitle>No goals yet</EmptyTitle>
              <EmptyDescription>
                A goal is a page or an event that counts as a success, such as viewing /pricing or
                signing up. Each shows how many of the visitors reached it, and what share of all of
                them that is.
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
              Of this page&apos;s visitors, in its period, environment, and filters: how many
              reached each goal, and their share. Visitors are counted per day, as in the summary;
              events count every time.
            </p>
          </>
        )}
      </CardContent>
      <AddGoalDialog
        open={adding}
        onOpenChange={setAdding}
        projectId={projectId}
        eventNames={eventNames}
        returnFocus={headingRef}
      />
    </Card>
  );
}
