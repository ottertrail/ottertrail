import { apiRequest, expectShape } from "./api";
import { characters } from "./text";

/**
 * A project's saved goals (docs/product-analytics.md): named conversions,
 * each a pageview of one path or a product event, as a funnel step is. The
 * analytics answer counts them in the page's visits.
 */

/** What reaching a goal means; the same shape as a funnel step. */
export type GoalStep =
  | { type: "event"; name: string; filter?: { key: string; value: string } }
  | { type: "page"; path: string };

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

/** Goals a project may have, as the API allows. */
export const MAX_GOALS = 20;

/** A goal's longest name, after trimming, as the API allows. */
export const MAX_GOAL_NAME = 100;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number";

export const isGoalStep = (value: unknown): value is GoalStep =>
  isRecord(value) &&
  ((value.type === "page" && isText(value.path)) ||
    (value.type === "event" &&
      isText(value.name) &&
      (value.filter === undefined ||
        (isRecord(value.filter) && isText(value.filter.key) && isText(value.filter.value)))));

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

// Control characters are what the API refuses in a goal's name.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/u;

/** Why a goal's name would be refused, as the API checks it; null when it would not. */
export function goalNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "Name the goal.";
  if (characters(trimmed) > MAX_GOAL_NAME) {
    return `A goal's name has at most ${MAX_GOAL_NAME} characters.`;
  }
  if (CONTROL.test(trimmed)) return "A goal's name cannot hold control characters.";
  return null;
}

const goalsPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/goals`;

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

/** "Viewed /pricing", "signup", "signup where plan = team". */
export function goalStepText(step: GoalStep): string {
  if (step.type === "page") return `Viewed ${step.path}`;
  if (step.filter === undefined) return step.name;
  const value = step.filter.value === "" ? "(empty)" : step.filter.value;
  return `${step.name} where ${step.filter.key} = ${value}`;
}
