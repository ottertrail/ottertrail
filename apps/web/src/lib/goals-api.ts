import { queryOptions } from "@tanstack/react-query";

import { apiRequest, expectShape } from "./api";
import { filterText, isStep, type Step } from "./steps";
import { nameProblem } from "./text";

/** Saved goals count conversions within the report visits (docs/product-analytics.md). */

/** What reaching a goal means; the same shape as a funnel step. */
export type GoalStep = Step;

export interface Goal {
  id: string;
  name: string;
  step: GoalStep;
  createdAt: string;
}

/** A goal in GET /api/projects/:id/analytics, counted in the page's visits. */
export interface GoalResult extends Goal {
  /** Daily visitor IDs that reached it. */
  visitors: number;
  /** How often it happened. */
  events: number;
  /** visitors / the page's visitors: 0 to 1; 0 without visitors. */
  conversionRate: number;
}

/**
 * A goal as the Web analytics page counts it. A shared link's answers
 * leave out what the goal matches (`step`) and when it was added: that is
 * Product analytics' setup, not the page's numbers (docs/web-analytics.md,
 * "Shared links").
 */
export type ReportGoal = Pick<
  GoalResult,
  "id" | "name" | "visitors" | "events" | "conversionRate"
> &
  Partial<Pick<GoalResult, "step" | "createdAt">>;

export const isReportGoal = (value: unknown): value is ReportGoal =>
  isRecord(value) &&
  isText(value.id) &&
  isText(value.name) &&
  isNumber(value.visitors) &&
  isNumber(value.events) &&
  isNumber(value.conversionRate) &&
  (value.step === undefined || isGoalStep(value.step)) &&
  (value.createdAt === undefined || isText(value.createdAt));

/** Goals a project may have, as the API allows. */
export const MAX_GOALS = 20;

/** A goal's longest name, after trimming, as the API allows. */
export const MAX_GOAL_NAME = 100;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number";

export const isGoalStep: (value: unknown) => value is GoalStep = isStep;

export const isGoal = (value: unknown): value is Goal =>
  isRecord(value) &&
  isText(value.id) &&
  isText(value.name) &&
  isGoalStep(value.step) &&
  isText(value.createdAt);

export const isGoalResult = (value: unknown): value is GoalResult =>
  isGoal(value) &&
  isRecord(value) &&
  isNumber(value.visitors) &&
  isNumber(value.events) &&
  isNumber(value.conversionRate);

/** Why a goal's name would be refused, as the API checks it; null when it would not. */
export const goalNameProblem = (name: string) => nameProblem(name, "goal", MAX_GOAL_NAME);

const goalsPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/goals`;

/** GET /api/projects/:id/goals: the project's goals, in the order added. */
export const goalsQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["goals", projectId],
    queryFn: async ({ signal }) =>
      expectShape(
        await apiRequest(goalsPath(projectId), { signal }),
        (value): value is { goals: Goal[] } =>
          isRecord(value) && Array.isArray(value.goals) && value.goals.every(isGoal),
      ).goals,
  });

/** POST /api/projects/:id/goals: the new goal, or an ApiError (invalid_name, goal_name_taken …). */
export async function createGoal(projectId: string, name: string, step: GoalStep): Promise<Goal> {
  const body = expectShape(
    await apiRequest(goalsPath(projectId), {
      method: "POST",
      body: { name: name.trim(), step },
    }),
    (value): value is { goal: Goal } => isRecord(value) && isGoal(value.goal),
  );
  return body.goal;
}

/** DELETE /api/projects/:id/goals/:goalId */
export async function deleteGoal(projectId: string, goalId: string): Promise<void> {
  await apiRequest(`${goalsPath(projectId)}/${encodeURIComponent(goalId)}`, { method: "DELETE" });
}

/** "Viewed /pricing", "signup", "signup where plan = team", "signup where plan ≠ free". */
export function goalStepText(step: GoalStep): string {
  if (step.type === "page") return `Viewed ${step.path}`;
  return step.filter === undefined ? step.name : `${step.name} where ${filterText(step.filter)}`;
}
