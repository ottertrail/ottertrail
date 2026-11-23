import type { QueryParams } from "../clickhouse/query.ts";
import { ENGAGEMENT, ERROR, PAGEVIEW, VITALS } from "../visits/visits.ts";
import { PRODUCT_EVENT, type PropertyFilter, propertyEquals } from "./events.ts";

/**
 * Tracker events cannot match product-event steps. Page steps represent
 * pageviews; errors have a separate page.
 */
export const TRACKER_EVENTS: readonly string[] = [PAGEVIEW, ENGAGEMENT, ERROR, VITALS];

/**
 * Shared by funnels and goals (funnel.ts; goals/goals.ts;
 * docs/product-analytics.md).
 */
export type Step =
  | { type: "event"; name: string; filter?: PropertyFilter | undefined }
  | { type: "page"; path: string };

// Match collection limits (collection/routes.ts).
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
 * Pass values through params. Requires name, path, properties, and
 * error_fingerprint columns.
 */
export function stepSql(params: QueryParams, step: Step): string {
  if (step.type === "page") {
    return `(name = '${PAGEVIEW}' AND path = ${params.add(step.path, "String")})`;
  }
  const filter = step.filter === undefined ? "" : ` AND ${propertyEquals(params, step.filter)}`;
  return `(${PRODUCT_EVENT} AND name = ${params.add(step.name, "String")}${filter})`;
}

/**
 * windowFunnel can count one event for adjacent matching steps, making
 * repeated steps always convert. Reject overlaps; same-name event steps
 * are separate only with different values for the same property.
 */
export function stepsOverlap(first: Step, second: Step): boolean {
  if (first.type === "page" && second.type === "page") return first.path === second.path;
  if (first.type === "page" || second.type === "page") return false;
  if (first.name !== second.name) return false;
  const [a, b] = [first.filter, second.filter];
  return !(a !== undefined && b !== undefined && a.key === b.key && a.value !== b.value);
}
