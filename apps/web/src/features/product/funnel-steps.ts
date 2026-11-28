import type { FunnelStep } from "@/lib/product-api";
import { cleanFilter, filterText, type StepFilter } from "@/lib/steps";
import { characters } from "@/lib/text";

/** Keep both name and path so switching step types preserves input. */
export interface DraftStep {
  id: number;
  type: FunnelStep["type"];
  name: string;
  path: string;
  filter: StepFilter | null;
  /** The saved goal this step was copied from, until the step is changed. */
  copiedFrom?: string | undefined;
}

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
    : {
        ...emptyStep(),
        name: step.name,
        filter: step.filter === undefined ? null : cleanFilter(step.filter),
      };

// Control characters are what the API refuses in names and paths; in
// property names only NUL, as collection does.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/u;

/** Limit paths so eight steps fit in an address. */
const MAX_PATH = 500;

/** The tracker's own events, which a step can never be (apps/api/src/product/steps.ts). */
const TRACKER_EVENTS: readonly string[] = [
  "pageview",
  "engagement",
  "error",
  "vitals",
  "not_found",
];

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
  // Preserve whitespace: "signup " and "signup" are different events.
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

/** Whether a path pattern matches a path: `*` is any run of characters. */
function pathMatches(pattern: string, path: string): boolean {
  const parts = pattern.split("*").map((part) => part.replaceAll(/[$()*+.?[\\\]^{|}]/gu, "\\$&"));
  return new RegExp(`^${parts.join(".*")}$`, "su").test(path);
}

/** Two paths, either a pattern, can both match some path (apps/api/src/product/steps.ts). */
function pathsOverlap(a: string, b: string): boolean {
  const [aStar, bStar] = [a.includes("*"), b.includes("*")];
  if (!aStar && !bStar) return a === b;
  if (!aStar) return pathMatches(b, a);
  if (!bStar) return pathMatches(a, b);
  const [aStart, bStart] = [a.slice(0, a.indexOf("*")), b.slice(0, b.indexOf("*"))];
  const [aEnd, bEnd] = [a.slice(a.lastIndexOf("*") + 1), b.slice(b.lastIndexOf("*") + 1)];
  return (
    (aStart.startsWith(bStart) || bStart.startsWith(aStart)) &&
    (aEnd.endsWith(bEnd) || bEnd.endsWith(aEnd))
  );
}

/** Two filters can both match one event (apps/api/src/product/steps.ts). */
function filtersOverlap(a: StepFilter, b: StepFilter): boolean {
  if (a.key !== b.key) return true;
  const [equals, other] = a.operator === undefined ? [a, b] : [b, a];
  if (equals.operator !== undefined) return true;
  if (other.operator === undefined) return equals.value === other.value;
  if (other.operator === "notEquals") return equals.value !== other.value;
  return equals.value.includes(other.value);
}

/** Overlapping steps always convert. Match apps/api/src/product/steps.ts. */
export function stepsOverlap(first: FunnelStep, second: FunnelStep): boolean {
  if (first.type === "page" && second.type === "page") {
    return pathsOverlap(first.path, second.path);
  }
  if (first.type === "page" || second.type === "page") return false;
  if (first.name !== second.name) return false;
  const [a, b] = [first.filter, second.filter];
  return a === undefined || b === undefined || filtersOverlap(a, b);
}

const OVERLAP =
  "One event could count for both this step and the previous one. Insert a step between them, or make them match different pages or property values.";

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

export const stepOf = (step: DraftStep): FunnelStep =>
  step.type === "page"
    ? { type: "page", path: step.path.trim() }
    : step.filter === null
      ? { type: "event", name: step.name }
      : { type: "event", name: step.name, filter: cleanFilter(step.filter) };

export function stepText(step: FunnelStep): string {
  if (step.type === "page") return step.path;
  return step.filter === undefined ? step.name : `${step.name} where ${filterText(step.filter)}`;
}
