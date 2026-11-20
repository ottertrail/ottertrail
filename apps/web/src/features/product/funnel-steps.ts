import type { FunnelStep } from "@/lib/product-api";
import { characters } from "@/lib/text";

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

/** The tracker's own events, which a step can never be (apps/api/src/product/steps.ts). */
const TRACKER_EVENTS: readonly string[] = ["pageview", "engagement", "error", "vitals"];

export function stepProblems(step: DraftStep): StepProblems {
  const problems: StepProblems = {};
  if (step.type === "page") {
    const path = step.path.trim();
    if (!path.startsWith("/")) problems.path = "A path starts with /, such as /pricing.";
    else if (/[?#]/.test(path))
      problems.path =
        "Paths are stored without queries (?) or fragments (#). Remove them from this path.";
    else if (CONTROL.test(path)) problems.path = "This path is not valid.";
    else if (characters(path) > MAX_PATH)
      problems.path = `A path here has at most ${MAX_PATH} characters.`;
    return problems;
  }
  // Names as the site sent them: "signup " is another event than "signup".
  const name = step.name;
  if (name === "") problems.name = "Name the event.";
  else if (TRACKER_EVENTS.includes(name)) {
    problems.name = `"${name}" is the tracker's own event: use a page step for a page, and the Errors page for errors.`;
  } else if (CONTROL.test(name) || characters(name) > 200) {
    problems.name =
      "An event name can contain at most 200 characters. Control characters are not allowed.";
  }
  if (step.filter !== null) {
    const { key } = step.filter;
    if (key === "") problems.filterKey = "Name the property, or remove the filter.";
    else if (key.includes("\u0000") || characters(key) > 100) {
      problems.filterKey = "A property name has at most 100 characters.";
    }
    if (characters(step.filter.value) > 500 || step.filter.value.includes("\u0000")) {
      problems.filterValue = "A value has at most 500 characters.";
    }
  }
  return problems;
}

export const hasProblems = (problems: StepProblems) => Object.keys(problems).length > 0;

/**
 * Whether one event could be both steps, as the API checks
 * (apps/api/src/product/steps.ts): it would count for both and always
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
  "One event could count for both this step and the previous one. Insert a step between them, or filter them by different values of the same property.";

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
