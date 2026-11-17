import type { QueryParams } from "../clickhouse/query.ts";
import { ENGAGEMENT, ERROR, PAGEVIEW, VITALS } from "../visits/visits.ts";
import { PRODUCT_EVENT, type PropertyFilter, propertyEquals } from "./events.ts";

/**
 * The tracker's own events: never product events, so an event step of one
 * of these names could never match. A page step stands for a pageview, and
 * errors have their own page.
 */
export const TRACKER_EVENTS: readonly string[] = [PAGEVIEW, ENGAGEMENT, ERROR, VITALS];

/**
 * Something a visitor or user does: a page viewed, or a product event with
 * an optional property filter. A funnel's step (funnel.ts), and a goal
 * (goals/goals.ts). See docs/product-analytics.md.
 */
export type Step =
  | { type: "event"; name: string; filter?: PropertyFilter | undefined }
  | { type: "page"; path: string };

// As collection allows them (collection/routes.ts). Control characters are
// what they refuse.
/* eslint-disable no-control-regex */
const NAME = /^[^\u0000-\u001F\u007F]{1,200}$/u;
/** Property names: collection refuses only NUL in them. */
export const KEY = /^[^\u0000]{1,100}$/u;
export const VALUE = /^[^\u0000]{0,500}$/u;
// A page: 500 characters keep five funnel steps within an address.
const PATH = /^\/[^\u0000-\u001F\u007F?#]{0,499}$/u;
/* eslint-enable no-control-regex */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A step's property filter, or null when it is not one. */
function filterOf(value: unknown): PropertyFilter | null {
  if (!isRecord(value)) return null;
  const { key, value: wanted } = value;
  return typeof key === "string" &&
    KEY.test(key) &&
    typeof wanted === "string" &&
    VALUE.test(wanted)
    ? { key, value: wanted }
    : null;
}

/**
 * A step from parsed JSON, or null when it is not one:
 * {"type":"event","name":"signup","filter":{"key":"plan","value":"team"}}
 * (filter optional) or {"type":"page","path":"/pricing"}.
 */
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

/**
 * SQL true for an event that is this step: a pageview of exactly the path,
 * or a product event of the name, with its filter. Values only through
 * `params`; the columns it reads are name, path, properties, and
 * error_fingerprint.
 */
export function stepSql(params: QueryParams, step: Step): string {
  if (step.type === "page") {
    return `(name = '${PAGEVIEW}' AND path = ${params.add(step.path, "String")})`;
  }
  const filter = step.filter === undefined ? "" : ` AND ${propertyEquals(params, step.filter)}`;
  return `(${PRODUCT_EVENT} AND name = ${params.add(step.name, "String")}${filter})`;
}

/**
 * Whether one event could be both steps. ClickHouse's windowFunnel lets one
 * event count for two funnel steps in a row when it matches both, so
 * "/pricing, then /pricing" would always convert: such steps are refused.
 * Two event steps of one name are apart only when both filter one property
 * by different values.
 */
export function stepsOverlap(first: Step, second: Step): boolean {
  if (first.type === "page" && second.type === "page") return first.path === second.path;
  if (first.type === "page" || second.type === "page") return false;
  if (first.name !== second.name) return false;
  const [a, b] = [first.filter, second.filter];
  return !(a !== undefined && b !== undefined && a.key === b.key && a.value !== b.value);
}
