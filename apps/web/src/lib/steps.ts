/**
 * The step shared by funnels and goals (apps/api/src/product/steps.ts;
 * docs/product-analytics.md, "Steps").
 */

/** How a step's filter compares; left out for equals. */
export const FILTER_OPERATORS = ["notEquals", "contains"] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

/** A property and a value, compared as text: equals unless it names an operator. */
export interface StepFilter {
  key: string;
  value: string;
  operator?: FilterOperator;
}

/** A page's path may hold `*`, which matches any run of characters, none included. */
export type Step =
  | { type: "event"; name: string; filter?: StepFilter }
  | { type: "page"; path: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";

export const isFilterOperator = (value: unknown): value is FilterOperator =>
  FILTER_OPERATORS.some((operator) => operator === value);

const isStepFilter = (value: unknown): value is StepFilter =>
  isRecord(value) &&
  isText(value.key) &&
  isText(value.value) &&
  (value.operator === undefined || isFilterOperator(value.operator));

export const isStep = (value: unknown): value is Step =>
  isRecord(value) &&
  ((value.type === "page" && isText(value.path)) ||
    (value.type === "event" &&
      isText(value.name) &&
      (value.filter === undefined || isStepFilter(value.filter))));

/** Only the fields the API reads, in its order, so steps compare as JSON text. */
export const cleanFilter = ({ key, value, operator }: StepFilter): StepFilter =>
  operator === undefined ? { key, value } : { key, value, operator };

const OPERATOR_TEXT: Record<FilterOperator | "equals", string> = {
  equals: "=",
  notEquals: "≠",
  contains: "contains",
};

/** "plan = team", "plan ≠ free", "plan contains team". */
export function filterText(filter: StepFilter): string {
  const value = filter.value === "" ? "(empty)" : filter.value;
  return `${filter.key} ${OPERATOR_TEXT[filter.operator ?? "equals"]} ${value}`;
}
