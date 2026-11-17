import type { FunnelStep } from "@/lib/product-api";

/**
 * A step while it is edited: both a name and a path, so switching the
 * type back keeps what was typed, and a filter that may still be empty.
 */
export interface DraftStep {
  /** For React's keys, so a moved step keeps its inputs. */
  id: number;
  type: FunnelStep["type"];
  name: string;
  path: string;
  /** null: no property filter. */
  filter: { key: string; value: string } | null;
}

/** What is wrong with a draft step's fields, as the API checks them. */
export interface StepProblems {
  name?: string;
  path?: string;
  filterKey?: string;
  filterValue?: string;
}

let nextId = 1;
const newId = () => nextId++;

export const emptyStep = (): DraftStep => ({
  id: newId(),
  type: "event",
  name: "",
  path: "",
  filter: null,
});

export const draftOf = (step: FunnelStep): DraftStep =>
  step.type === "page"
    ? { ...emptyStep(), type: "page", path: step.path }
    : { ...emptyStep(), name: step.name, filter: step.filter ?? null };

// Control characters are what the API refuses in names and paths; in
// property names only NUL, as collection does.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/u;

/** A page step's longest path: five of them still fit in an address. */
const MAX_PATH = 500;

export function stepProblems(step: DraftStep): StepProblems {
  const problems: StepProblems = {};
  if (step.type === "page") {
    const path = step.path.trim();
    if (!path.startsWith("/")) problems.path = "A path starts with /, such as /pricing.";
    else if (/[?#]/.test(path)) problems.path = "A path has no query (?) or fragment (#).";
    else if (CONTROL.test(path)) problems.path = "This path is not valid.";
    else if (path.length > MAX_PATH)
      problems.path = `A path here has at most ${MAX_PATH} characters.`;
    return problems;
  }
  // Names as the site sent them: "signup " is another event than "signup".
  const name = step.name;
  if (name === "") problems.name = "Name the event.";
  else if (CONTROL.test(name) || name.length > 200) {
    problems.name = "An event name has at most 200 characters, and no control characters.";
  }
  if (step.filter !== null) {
    const { key } = step.filter;
    if (key === "") problems.filterKey = "Name the property, or remove the filter.";
    else if (key.includes("\u0000") || key.length > 100) {
      problems.filterKey = "A property name has at most 100 characters.";
    }
    if (step.filter.value.length > 500 || step.filter.value.includes("\u0000")) {
      problems.filterValue = "A value has at most 500 characters.";
    }
  }
  return problems;
}

export const hasProblems = (problems: StepProblems) => Object.keys(problems).length > 0;

/**
 * Whether one event could be both steps, as the API checks
 * (apps/api/src/product/funnel.ts): it would count for both and always
 * convert. Steps of one event name are apart only when both filter one
 * property by different values.
 */
export function stepsOverlap(first: FunnelStep, second: FunnelStep): boolean {
  if (first.type === "page" && second.type === "page") return first.path === second.path;
  if (first.type === "page" || second.type === "page") return false;
  if (first.name !== second.name) return false;
  const [a, b] = [first.filter, second.filter];
  return !(a !== undefined && b !== undefined && a.key === b.key && a.value !== b.value);
}

const OVERLAP =
  "One event could be this step and the one before, and would count for both. Put another step between, or filter both by different values of one property.";

/** Each step's problems, and, for a step one event could share with the step before, that. */
export function allStepProblems(drafts: readonly DraftStep[]): StepProblems[] {
  const problems = drafts.map(stepProblems);
  drafts.forEach((step, index) => {
    const before = drafts[index - 1];
    const own = problems[index] ?? {};
    if (
      before === undefined ||
      hasProblems(problems[index - 1] ?? {}) ||
      hasProblems(own) ||
      !stepsOverlap(stepOf(before), stepOf(step))
    ) {
      return;
    }
    problems[index] = step.type === "page" ? { ...own, path: OVERLAP } : { ...own, name: OVERLAP };
  });
  return problems;
}

/** The step as the API takes it; call only when it has no problems. */
export const stepOf = (step: DraftStep): FunnelStep =>
  step.type === "page"
    ? { type: "page", path: step.path.trim() }
    : step.filter === null
      ? { type: "event", name: step.name }
      : { type: "event", name: step.name, filter: { ...step.filter } };

/** "signup", "signup where plan = team", "/pricing". */
export function stepText(step: FunnelStep): string {
  if (step.type === "page") return step.path;
  return step.filter === undefined
    ? step.name
    : `${step.name} where ${step.filter.key} = ${step.filter.value === "" ? "(empty)" : step.filter.value}`;
}
