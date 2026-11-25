import type { QueryParams } from "../clickhouse/query.ts";
import { ENGAGEMENT, ERROR, PAGEVIEW, VITALS } from "../visits/visits.ts";
import { PRODUCT_EVENT, type PropertyFilter, propertyText } from "./events.ts";

/**
 * Tracker events cannot match product-event steps. Page steps represent
 * pageviews; errors have a separate page.
 */
export const TRACKER_EVENTS: readonly string[] = [PAGEVIEW, ENGAGEMENT, ERROR, VITALS];

/** How a step's filter compares; left out for equals. */
export const FILTER_OPERATORS = ["notEquals", "contains"] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

/** A step's property filter: equals unless it names an operator. */
export interface StepFilter extends PropertyFilter {
  operator?: FilterOperator | undefined;
}

/**
 * Shared by funnels and goals (funnel.ts; goals/goals.ts;
 * docs/product-analytics.md, "Steps"). A page's path may hold `*`, which
 * matches any run of characters, none included.
 */
export type Step =
  | { type: "event"; name: string; filter?: StepFilter | undefined }
  | { type: "page"; path: string };

// Match collection limits (collection/routes.ts).
/* eslint-disable no-control-regex */
const NAME = /^[^\u0000-\u001F\u007F]{1,200}$/u;
/** Property names: collection refuses only NUL in them. */
export const KEY = /^[^\u0000]{1,100}$/u;
export const VALUE = /^[^\u0000]{0,500}$/u;
// A page: 500 characters keep eight funnel steps within an address.
const PATH = /^\/[^\u0000-\u001F\u007F?#]{0,499}$/u;
/* eslint-enable no-control-regex */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isOperator = (value: unknown): value is FilterOperator =>
  FILTER_OPERATORS.some((operator) => operator === value);

function filterOf(value: unknown): StepFilter | null {
  if (!isRecord(value)) return null;
  const { key, value: wanted, operator } = value;
  if (typeof key !== "string" || !KEY.test(key) || typeof wanted !== "string") return null;
  if (!VALUE.test(wanted)) return null;
  if (operator === undefined) return { key, value: wanted };
  return isOperator(operator) ? { key, value: wanted, operator } : null;
}

export function stepOf(item: unknown): Step | null {
  if (!isRecord(item)) return null;
  if (item.type === "page") {
    return typeof item.path === "string" && PATH.test(item.path)
      ? { type: "page", path: item.path }
      : null;
  }
  if (
    item.type !== "event" ||
    typeof item.name !== "string" ||
    !NAME.test(item.name) ||
    TRACKER_EVENTS.includes(item.name)
  ) {
    return null;
  }
  if (item.filter === undefined) return { type: "event", name: item.name };
  const filter = filterOf(item.filter);
  return filter === null ? null : { type: "event", name: item.name, filter };
}

/** A path pattern as a LIKE pattern: `\`, `%`, and `_` literal, `*` any run. */
export const likePattern = (path: string): string =>
  path.replaceAll(/[\\%_]/gu, (character) => `\\${character}`).replaceAll("*", "%");

/**
 * A missing property matches no filter, "not equals" included. Values
 * compare as text (events.ts, propertyText), case-sensitively.
 */
function filterSql(params: QueryParams, filter: StepFilter): string {
  const name = params.add(filter.key, "String");
  const text = propertyText(name);
  const value = params.add(filter.value, "String");
  const compared =
    filter.operator === "notEquals"
      ? `${text} != ${value}`
      : filter.operator === "contains"
        ? `position(${text}, ${value}) > 0`
        : `${text} = ${value}`;
  return `(JSONHas(properties, ${name}) AND ${compared})`;
}

/**
 * Pass values through params. Requires name, path, properties, and
 * error_fingerprint columns.
 */
export function stepSql(params: QueryParams, step: Step): string {
  if (step.type === "page") {
    const path = step.path.includes("*")
      ? `path LIKE ${params.add(likePattern(step.path), "String")}`
      : `path = ${params.add(step.path, "String")}`;
    return `(name = '${PAGEVIEW}' AND ${path})`;
  }
  const filter = step.filter === undefined ? "" : ` AND ${filterSql(params, step.filter)}`;
  return `(${PRODUCT_EVENT} AND name = ${params.add(step.name, "String")}${filter})`;
}

/** Whether a path pattern matches a path, as stepSql's LIKE does. */
export function pathMatches(pattern: string, path: string): boolean {
  const parts = pattern.split("*").map((part) => part.replaceAll(/[$()*+.?[\\\]^{|}]/gu, "\\$&"));
  return new RegExp(`^${parts.join(".*")}$`, "su").test(path);
}

/**
 * Whether two page paths, either a pattern, can both match some path. Two
 * patterns can exactly when one's text before its first `*` starts the
 * other's and one's text after its last `*` ends the other's: the stars
 * between can take up the rest.
 */
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

/**
 * Whether two filters can both match one event. On one property: two
 * equals only on the same value, equals and not equals only on different
 * values, equals and contains when the value contains the text; every
 * other pair can. Filters on different properties count as overlapping.
 */
function filtersOverlap(a: StepFilter, b: StepFilter): boolean {
  if (a.key !== b.key) return true;
  const [equals, other] = a.operator === undefined ? [a, b] : [b, a];
  if (equals.operator !== undefined) return true;
  if (other.operator === undefined) return equals.value === other.value;
  if (other.operator === "notEquals") return equals.value !== other.value;
  return equals.value.includes(other.value);
}

/**
 * windowFunnel can count one event for adjacent matching steps, making
 * repeated steps always convert. Reject steps that can both match one
 * event: pages whose paths can, and events of one name whose filters can.
 */
export function stepsOverlap(first: Step, second: Step): boolean {
  if (first.type === "page" && second.type === "page") {
    return pathsOverlap(first.path, second.path);
  }
  if (first.type === "page" || second.type === "page") return false;
  if (first.name !== second.name) return false;
  const [a, b] = [first.filter, second.filter];
  return a === undefined || b === undefined || filtersOverlap(a, b);
}
