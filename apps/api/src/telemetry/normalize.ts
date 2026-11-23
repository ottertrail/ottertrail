import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import {
  DEFAULT_ENVIRONMENT,
  ENVIRONMENT_PATTERN,
  RELEASE_PATTERN,
} from "../collection/environment.ts";
import type { NewEvent } from "../collection/event-store.ts";
import { isAiContent, isAiContentEvent } from "./ai-content.ts";
import {
  EXCEPTION_MESSAGE,
  EXCEPTION_STACKTRACE,
  EXCEPTION_TYPE,
  type ExceptionAttributes,
  exceptionEvent,
  isException,
  MAX_EXCEPTIONS_PER_SPAN,
} from "./exceptions.ts";
import {
  bool,
  bytesOf,
  double,
  doubleOf,
  field,
  has,
  id,
  int32,
  int64Of,
  list,
  MalformedError,
  message,
  messages,
  text,
  uint64,
} from "./read.ts";
import { countFields } from "./wire.ts";

/**
 * Stable rows let ReplacingMergeTree deduplicate retries (clickhouse/migrations.ts;
 * docs/telemetry.md). Logs without timestamps use arrival time and are stored again on retry.
 * Exceptions also become error events (exceptions.ts).
 */

/** Excess attributes are dropped and counted. */
export const MAX_ATTRIBUTES = 128;
export const MAX_KEY_CHARS = 256;
export const MAX_VALUE_BYTES = 4 * 1024;
/** Caps combined key/value bytes in key order because each record copies its resource. */
export const MAX_RESOURCE_ATTRIBUTE_BYTES = 8 * 1024;
export const MAX_NAME_BYTES = 1024;
export const MAX_BODY_BYTES = 64 * 1024;
/** Caps events and links separately. Excess items are dropped and counted. */
export const MAX_SPAN_EVENTS = 128;
export const MAX_SPAN_LINKS = 128;
/** Character limit for service, scope, severity, and unit labels. */
const MAX_LABEL_CHARS = 256;
/** Deeper nested values are omitted. */
const MAX_VALUE_DEPTH = 16;

const NANOS_PER_SECOND = 1_000_000_000n;
const NANOS_PER_DAY = 86_400n * NANOS_PER_SECOND;
const MAX_AHEAD_NS = 3600n * NANOS_PER_SECOND;
/** Slack after a span ends for using an exception event's timestamp. */
const EXCEPTION_SLACK_NS = 60n * NANOS_PER_SECOND;
const MAX_UINT32 = 0xffff_ffff;
const MAX_UINT64 = 0xffff_ffff_ffff_ffffn;
/** Keeps histogram differences within signed Int64 to prevent negative overflow. */
const MAX_HISTOGRAM_COUNT = 0x7fff_ffff_ffff_ffffn;
/** Bounds chart memory. OpenTelemetry defaults to 15 bounds; Prometheus classic uses 11. */
export const MAX_HISTOGRAM_BOUNDS = 64;

const ENVIRONMENT = new RegExp(ENVIRONMENT_PATTERN);
const RELEASE = new RegExp(RELEASE_PATTERN);

export interface NormalizeContext {
  projectId: string;
  /** When the request arrived, in nanoseconds since 1970. */
  receivedAtNs: bigint;
  /** Older records are refused. */
  retentionDays: number;
}

interface Labels {
  project_id: string;
  service: string;
  release: string;
  environment: string;
  scope_name: string;
  scope_version: string;
}

interface Origin extends Labels {
  resource_attributes: Record<string, string>;
}

export interface SpanRow extends Origin {
  timestamp: string;
  id: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string;
  name: string;
  kind: number;
  duration_ns: string;
  status_code: number;
  status_message: string;
  attributes: Record<string, string>;
  dropped_attributes_count: number;
  /** JSON: [{ time, name, attributes }], time in nanoseconds since 1970, as text. */
  events: string;
  dropped_events_count: number;
  /** JSON: [{ traceId, spanId, attributes }]. */
  links: string;
  dropped_links_count: number;
}

export interface LogRow extends Origin {
  timestamp: string;
  id: string;
  observed_timestamp: string;
  severity_number: number;
  severity_text: string;
  body: string;
  trace_id: string;
  span_id: string;
  event_name: string;
  attributes: Record<string, string>;
  dropped_attributes_count: number;
}

export interface PointRow extends Origin {
  timestamp: string;
  id: string;
  start_timestamp: string;
  name: string;
  unit: string;
  kind: "gauge" | "sum";
  temporality: number;
  monotonic: boolean;
  value: number;
  attributes: Record<string, string>;
  dropped_attributes_count: number;
}

export interface HistogramRow extends Origin {
  timestamp: string;
  id: string;
  start_timestamp: string;
  name: string;
  unit: string;
  temporality: number;
  count: string;
  sum: number | null;
  min: number | null;
  max: number | null;
  bounds: number[];
  bucket_counts: string[];
  attributes: Record<string, string>;
  dropped_attributes_count: number;
}

export interface Outcome {
  /** Includes refused records. */
  records: number;
  refused: number;
  /** Refusal reasons for partial_success; "" if none. */
  message: string;
  /** Counts each row's copy of resource attributes sent once in the request. */
  sharedBytes: number;
}

class Refusals {
  count = 0;
  readonly #reasons = new Set<string>();

  add(reason: string, count = 1) {
    if (count === 0) return;
    this.count += count;
    this.#reasons.add(reason);
  }

  outcome(records: number, noun: string, sharedBytes: number): Outcome {
    return {
      records,
      sharedBytes,
      refused: this.count,
      message:
        this.count === 0
          ? ""
          : `${this.count} of ${records} ${noun} refused: ${[...this.#reasons].join("; ")}.`,
    };
  }
}

/** Formats DateTime64(9, 'UTC'), e.g. "2026-11-18 12:00:00.123456789". */
export function nanosText(ns: bigint): string {
  const seconds = ns / NANOS_PER_SECOND;
  const fraction = ns % NANOS_PER_SECOND;
  const whole = new Date(Number(seconds) * 1000).toISOString().slice(0, 19).replace("T", " ");
  return `${whole}.${fraction.toString().padStart(9, "0")}`;
}

/** Cuts at UTF-8 boundaries and replaces unpaired surrogates. */
export function cutBytes(value: string, max: number): string {
  const wellFormed = value.toWellFormed();
  // A UTF-16 unit needs at most 3 UTF-8 bytes.
  if (wellFormed.length * 3 <= max || Buffer.byteLength(wellFormed) <= max) return wellFormed;
  const cut = Buffer.from(wellFormed).subarray(0, max).toString("utf8");
  // Remove U+FFFD from a split trailing character.
  return wellFormed.startsWith(cut) ? cut : cut.slice(0, -1);
}

const isControl = (code: number) => code < 0x20 || (code >= 0x7f && code <= 0x9f);

/** Strips control characters to match dashboard filters; caps at MAX_LABEL_CHARS. */
export function label(value: string): string {
  let clean = "";
  for (const char of value) {
    if (!isControl(char.charCodeAt(0))) clean += char;
  }
  return cutChars(clean, MAX_LABEL_CHARS);
}

/** Cuts to `max` UTF-16 units and replaces a split surrogate pair. */
export function cutChars(value: string, max: number): string {
  return (value.length <= max ? value : value.slice(0, max)).toWellFormed();
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** Serializes integers beyond double precision as text. */
function jsonOf(value: object | undefined, depth: number): Json {
  if (value === undefined) return null;
  if (depth > MAX_VALUE_DEPTH) return null;
  if (has(value, "stringValue")) return text(value, "stringValue");
  if (has(value, "boolValue")) return bool(value, "boolValue");
  if (has(value, "intValue")) {
    const integer = int64Of(field(value, "intValue"), "intValue");
    const number = Number(integer);
    return Number.isSafeInteger(number) ? number : integer.toString();
  }
  if (has(value, "doubleValue")) {
    const number = doubleOf(field(value, "doubleValue"), "doubleValue");
    return Number.isFinite(number) ? number : String(number);
  }
  if (has(value, "bytesValue"))
    return bytesOf(field(value, "bytesValue"), "bytesValue").toString("hex");
  const array = message(value, "arrayValue");
  if (array !== undefined) {
    return messages(array, "values").map((item) => jsonOf(item, depth + 1));
  }
  const kvlist = message(value, "kvlistValue");
  if (kvlist !== undefined) {
    return Object.fromEntries(
      messages(kvlist, "values").map((pair) => [
        text(pair, "key"),
        jsonOf(message(pair, "value"), depth + 1),
      ]),
    );
  }
  return null;
}

/** Strings pass through; bytes use hex; lists and maps use JSON; absent values use "". */
export function valueText(value: object | undefined): string {
  if (value === undefined) return "";
  if (has(value, "stringValue")) return text(value, "stringValue");
  if (has(value, "intValue")) return int64Of(field(value, "intValue"), "intValue").toString();
  if (has(value, "doubleValue"))
    return String(doubleOf(field(value, "doubleValue"), "doubleValue"));
  const json = jsonOf(value, 0);
  if (json === null) return "";
  return typeof json === "string" ? json : JSON.stringify(json);
}

/** Key order makes serialized attributes stable. */
function sortedObject(map: Map<string, string>): Record<string, string> {
  return Object.fromEntries([...map].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Caps attributes at MAX_ATTRIBUTES, keys at MAX_KEY_CHARS, and values at MAX_VALUE_BYTES.
 * Duplicate keys keep the last value. `withoutAiContent` drops prompts and completions from
 * resources, spans, events, links, and logs (ai-content.ts). `dropped` counts omissions.
 */
export function flattenAttributes(
  items: object[],
  withoutAiContent = false,
): {
  attributes: Record<string, string>;
  dropped: number;
} {
  const attributes = new Map<string, string>();
  let dropped = 0;
  for (const item of items) {
    const key = cutChars(text(item, "key"), MAX_KEY_CHARS);
    if (withoutAiContent && isAiContent(key)) {
      dropped += 1;
      continue;
    }
    if (!attributes.has(key) && attributes.size >= MAX_ATTRIBUTES) {
      dropped += 1;
      continue;
    }
    attributes.set(key, cutBytes(valueText(message(item, "value")), MAX_VALUE_BYTES));
  }
  return { attributes: sortedObject(attributes), dropped };
}

function droppedCount(from: object, ours: number): number {
  return Math.min(MAX_UINT32, Math.max(0, int32(from, "droppedAttributesCount")) + ours);
}

/** Matches tracker environments: lowercase, defaulting to "production" when absent or invalid. */
export function environmentOfResource(attributes: Record<string, string>): string {
  const sent = attributes["deployment.environment.name"] ?? attributes["deployment.environment"];
  return sent !== undefined && ENVIRONMENT.test(sent) ? sent.toLowerCase() : DEFAULT_ENVIRONMENT;
}

/** Keeps attributes in key order within `max` combined UTF-8 bytes. */
export function keepWithin(
  attributes: Record<string, string>,
  max: number,
): { attributes: Record<string, string>; bytes: number } {
  const kept: Record<string, string> = {};
  let bytes = 0;
  for (const [key, value] of Object.entries(attributes)) {
    const size = Buffer.byteLength(key) + Buffer.byteLength(value);
    if (bytes + size > max) break;
    kept[key] = value;
    bytes += size;
  }
  return { attributes: kept, bytes };
}

interface Resource {
  labels: Omit<Labels, "scope_name" | "scope_version">;
  attributes: Record<string, string>;
  bytes: number;
  /** Reused in record content IDs to avoid hashing attributes per row. */
  hash: string;
}

function resourceOf(container: object, projectId: string): Resource {
  const resource = message(container, "resource");
  const { attributes: all } = flattenAttributes(
    resource === undefined ? [] : messages(resource, "attributes"),
    true,
  );
  const service = label(all["service.name"] ?? "");
  const version = all["service.version"] ?? "";
  const { attributes, bytes } = keepWithin(all, MAX_RESOURCE_ATTRIBUTE_BYTES);
  return {
    labels: {
      project_id: projectId,
      service: service === "" ? "unknown_service" : service,
      release: RELEASE.test(version) ? version : "",
      environment: environmentOfResource(all),
    },
    attributes,
    bytes,
    hash: createHash("sha256").update(JSON.stringify(attributes)).digest("hex"),
  };
}

function withScope(resource: Resource, container: object): Labels {
  const scope = message(container, "scope");
  return {
    ...resource.labels,
    scope_name: scope === undefined ? "" : label(text(scope, "name")),
    scope_version: scope === undefined ? "" : label(text(scope, "version")),
  };
}

function timeProblem(ns: bigint, context: NormalizeContext): string | null {
  if (ns > context.receivedAtNs + MAX_AHEAD_NS) {
    return "times more than an hour ahead of the server's clock";
  }
  if (ns < context.receivedAtNs - BigInt(context.retentionDays) * NANOS_PER_DAY) {
    return `times older than the ${context.retentionDays} days telemetry is kept`;
  }
  return null;
}

/**
 * Uses the first 16 SHA-256 bytes of row content and resource hash. Hashing attributes once per
 * resource bounds work to request size.
 */
function contentId(resource: Resource, row: object): string {
  return createHash("sha256")
    .update(resource.hash)
    .update(JSON.stringify(row))
    .digest("hex")
    .slice(0, 32);
}

/** Out-of-range enums become 0 (unspecified). */
function enumValue(from: object, key: string, max: number): number {
  const value = int32(from, key);
  return value >= 0 && value <= max ? value : 0;
}

const ZERO_TRACE = "0".repeat(32);
const ZERO_SPAN = "0".repeat(16);

/** OTLP all-zero optional IDs become "": parents become roots and logs have no trace. */
function optionalId(from: object, key: string, length: number): string {
  const value = id(from, key, length);
  return value === ZERO_TRACE || value === ZERO_SPAN ? "" : value;
}

/** Reads original KeyValues so stacks use error limits (exceptions.ts) rather than MAX_VALUE_BYTES. */
function exceptionAttributesOf(items: object[]): ExceptionAttributes {
  const found: ExceptionAttributes = {};
  for (const item of items) {
    const key = text(item, "key");
    if (key === EXCEPTION_TYPE) found.type = valueText(message(item, "value"));
    else if (key === EXCEPTION_MESSAGE) found.message = valueText(message(item, "value"));
    else if (key === EXCEPTION_STACKTRACE) found.stacktrace = valueText(message(item, "value"));
  }
  return found;
}

/** Duplicate keys keep the last value; absent keys return "". */
function attributeText(items: object[], key: string): string {
  let found = "";
  for (const item of items) {
    if (text(item, "key") === key) found = valueText(message(item, "value"));
  }
  return found;
}

function errorLabels(resource: Resource) {
  return {
    projectId: resource.labels.project_id,
    service: resource.labels.service,
    environment: resource.labels.environment,
    release: resource.labels.release,
  };
}

/** Converts kept spans' first MAX_EXCEPTIONS_PER_SPAN exception events to errors too. */
export function normalizeTraces(
  request: object,
  context: NormalizeContext,
): Outcome & { rows: SpanRow[]; errors: NewEvent[] } {
  const rows: SpanRow[] = [];
  const errors: NewEvent[] = [];
  const refusals = new Refusals();
  let records = 0;
  let sharedBytes = 0;
  for (const resourceSpans of messages(request, "resourceSpans")) {
    const resource = resourceOf(resourceSpans, context.projectId);
    for (const scopeSpans of messages(resourceSpans, "scopeSpans")) {
      const shared: Origin = {
        ...withScope(resource, scopeSpans),
        resource_attributes: resource.attributes,
      };
      for (const span of messages(scopeSpans, "spans")) {
        records += 1;
        const traceId = id(span, "traceId", 16);
        const spanId = id(span, "spanId", 8);
        if (traceId === "" || spanId === "" || traceId === ZERO_TRACE || spanId === ZERO_SPAN) {
          refusals.add("spans without a trace ID and a span ID");
          continue;
        }
        const start = uint64(span, "startTimeUnixNano");
        const end = uint64(span, "endTimeUnixNano");
        const problem = start === 0n ? "spans without a start time" : timeProblem(start, context);
        if (problem !== null) {
          refusals.add(problem);
          continue;
        }
        if (end < start) {
          refusals.add("spans that end before they start");
          continue;
        }
        // Cap end times at one hour ahead too: they bound duration and exception timestamps.
        const endProblem = timeProblem(end, context);
        if (endProblem !== null) {
          refusals.add(endProblem);
          continue;
        }
        const { attributes, dropped } = flattenAttributes(messages(span, "attributes"), true);
        const events = messages(span, "events");
        const links = messages(span, "links");
        const status = message(span, "status");
        const statusCode = status === undefined ? 0 : enumValue(status, "code", 2);
        sharedBytes += resource.bytes;
        rows.push({
          ...shared,
          timestamp: nanosText(start),
          id: traceId + spanId,
          trace_id: traceId,
          span_id: spanId,
          parent_span_id: optionalId(span, "parentSpanId", 8),
          name: cutBytes(text(span, "name"), MAX_NAME_BYTES),
          kind: enumValue(span, "kind", 5),
          duration_ns: (end - start).toString(),
          status_code: statusCode,
          status_message:
            status === undefined ? "" : cutBytes(text(status, "message"), MAX_VALUE_BYTES),
          attributes,
          dropped_attributes_count: droppedCount(span, dropped),
          events: JSON.stringify(
            events.slice(0, MAX_SPAN_EVENTS).map((event) => ({
              time: uint64(event, "timeUnixNano").toString(),
              name: cutBytes(text(event, "name"), MAX_NAME_BYTES),
              attributes: flattenAttributes(messages(event, "attributes"), true).attributes,
            })),
          ),
          dropped_events_count: Math.min(
            MAX_UINT32,
            Math.max(0, int32(span, "droppedEventsCount")) +
              Math.max(0, events.length - MAX_SPAN_EVENTS),
          ),
          links: JSON.stringify(
            links.slice(0, MAX_SPAN_LINKS).map((link) => ({
              traceId: optionalId(link, "traceId", 16),
              spanId: optionalId(link, "spanId", 8),
              attributes: flattenAttributes(messages(link, "attributes"), true).attributes,
            })),
          ),
          dropped_links_count: Math.min(
            MAX_UINT32,
            Math.max(0, int32(span, "droppedLinksCount")) +
              Math.max(0, links.length - MAX_SPAN_LINKS),
          ),
        });
        let exceptions = 0;
        // Only retained span events can become errors, so the span still holds each error.
        for (const [position, event] of events.slice(0, MAX_SPAN_EVENTS).entries()) {
          if (exceptions === MAX_EXCEPTIONS_PER_SPAN) break;
          if (text(event, "name") !== "exception") continue;
          const exception = exceptionAttributesOf(messages(event, "attributes"));
          if (!isException(exception)) continue;
          exceptions += 1;
          const time = uint64(event, "timeUnixNano");
          errors.push(
            exceptionEvent({
              ...errorLabels(resource),
              attributes,
              exception,
              // Use event time within the span plus a minute of slack; otherwise use span start.
              // This stays stable on retry.
              occurredAtNs: time >= start && time <= end + EXCEPTION_SLACK_NS ? time : start,
              // Exceptions on spans without error status are treated as handled.
              handled: statusCode !== 2,
              traceId,
              spanId,
              // Include event position so identical exceptions remain distinct.
              identity: [
                "span",
                traceId,
                spanId,
                position.toString(),
                time.toString(),
                exception.type ?? "",
                exception.message ?? "",
              ],
            }),
          );
        }
      }
    }
  }
  return { rows, errors, ...refusals.outcome(records, "spans", sharedBytes) };
}

/** Logs with exception.type or exception.message also become errors. */
export function normalizeLogs(
  request: object,
  context: NormalizeContext,
): Outcome & { rows: LogRow[]; errors: NewEvent[] } {
  const rows: LogRow[] = [];
  const errors: NewEvent[] = [];
  const refusals = new Refusals();
  let records = 0;
  let sharedBytes = 0;
  for (const resourceLogs of messages(request, "resourceLogs")) {
    const resource = resourceOf(resourceLogs, context.projectId);
    for (const scopeLogs of messages(resourceLogs, "scopeLogs")) {
      const shared = withScope(resource, scopeLogs);
      for (const record of messages(scopeLogs, "logRecords")) {
        records += 1;
        const time = uint64(record, "timeUnixNano");
        const observed = uint64(record, "observedTimeUnixNano");
        const at = time !== 0n ? time : observed !== 0n ? observed : context.receivedAtNs;
        const problem = timeProblem(at, context);
        if (problem !== null) {
          refusals.add(problem);
          continue;
        }
        const items = messages(record, "attributes");
        const { attributes, dropped } = flattenAttributes(items, true);
        const eventName = text(record, "eventName");
        // GenAI event bodies contain messages to drop and count. Older SDKs put the event name in
        // an attribute.
        const body = valueText(message(record, "body"));
        const aiBody =
          body !== "" &&
          (isAiContentEvent(eventName) || isAiContentEvent(attributeText(items, "event.name")));
        const row: Omit<LogRow, "id" | "resource_attributes"> = {
          ...shared,
          timestamp: nanosText(at),
          observed_timestamp: nanosText(
            observed !== 0n && observed <= context.receivedAtNs + MAX_AHEAD_NS ? observed : at,
          ),
          severity_number: enumValue(record, "severityNumber", 24),
          severity_text: label(text(record, "severityText")),
          body: aiBody ? "" : cutBytes(body, MAX_BODY_BYTES),
          trace_id: optionalId(record, "traceId", 16),
          span_id: optionalId(record, "spanId", 8),
          event_name: label(eventName),
          attributes,
          dropped_attributes_count: droppedCount(record, aiBody ? dropped + 1 : dropped),
        };
        sharedBytes += resource.bytes;
        const rowId = contentId(resource, row);
        rows.push({ ...row, resource_attributes: resource.attributes, id: rowId });
        const exception = exceptionAttributesOf(items);
        if (isException(exception)) {
          errors.push(
            exceptionEvent({
              ...errorLabels(resource),
              attributes,
              exception,
              occurredAtNs: at,
              // Severity 1 through 16 is handled; ERROR (17) and above, or absent severity, is
              // unhandled.
              handled: row.severity_number >= 1 && row.severity_number <= 16,
              traceId: row.trace_id,
              spanId: row.span_id,
              // Use sent content for identity; a timestamp derived from arrival changes on retry.
              identity: [
                "log",
                resource.hash,
                time.toString(),
                observed.toString(),
                JSON.stringify([
                  row.scope_name,
                  row.scope_version,
                  row.severity_number,
                  row.severity_text,
                  row.body,
                  row.trace_id,
                  row.span_id,
                  row.event_name,
                  attributes,
                ]),
              ],
            }),
          );
        }
      }
    }
  }
  return { rows, errors, ...refusals.outcome(records, "log records", sharedBytes) };
}

/** OTLP DataPointFlags: marks a missing value. */
const NO_RECORDED_VALUE = 1;

function pointTimes(
  point: object,
  context: NormalizeContext,
): { time: bigint; start: bigint } | { problem: string } {
  const time = uint64(point, "timeUnixNano");
  if (time === 0n) return { problem: "data points without a time" };
  const problem = timeProblem(time, context);
  if (problem !== null) return { problem };
  const start = uint64(point, "startTimeUnixNano");
  return { time, start: start <= time ? start : 0n };
}

/** Absent and non-finite values become null. */
function finiteOrNull(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) ? value : null;
}

export function normalizeMetrics(
  request: object,
  context: NormalizeContext,
): Outcome & { points: PointRow[]; histograms: HistogramRow[] } {
  const points: PointRow[] = [];
  const histograms: HistogramRow[] = [];
  const refusals = new Refusals();
  let records = 0;
  let sharedBytes = 0;
  for (const resourceMetrics of messages(request, "resourceMetrics")) {
    const resource = resourceOf(resourceMetrics, context.projectId);
    for (const scopeMetrics of messages(resourceMetrics, "scopeMetrics")) {
      const shared = withScope(resource, scopeMetrics);
      for (const metric of messages(scopeMetrics, "metrics")) {
        const name = cutBytes(text(metric, "name"), MAX_NAME_BYTES);
        const unit = label(text(metric, "unit"));
        const gauge = message(metric, "gauge");
        const sum = message(metric, "sum");
        const histogram = message(metric, "histogram");
        const unsupported = message(metric, "exponentialHistogram") ?? message(metric, "summary");

        if (gauge !== undefined || sum !== undefined) {
          const data = gauge ?? sum ?? {};
          for (const point of messages(data, "dataPoints")) {
            records += 1;
            const times = pointTimes(point, context);
            if ("problem" in times) {
              refusals.add(times.problem);
              continue;
            }
            let value: number;
            if (has(point, "asDouble")) {
              value = doubleOf(field(point, "asDouble"), "asDouble");
            } else if (has(point, "asInt")) {
              value = Number(int64Of(field(point, "asInt"), "asInt"));
            } else {
              refusals.add("data points without a value");
              continue;
            }
            if ((int32(point, "flags") & NO_RECORDED_VALUE) !== 0) {
              refusals.add("data points without a value");
              continue;
            }
            if (!Number.isFinite(value)) {
              refusals.add("values that are not finite numbers");
              continue;
            }
            const { attributes, dropped } = flattenAttributes(messages(point, "attributes"));
            const row: Omit<PointRow, "id" | "resource_attributes"> = {
              ...shared,
              timestamp: nanosText(times.time),
              start_timestamp: nanosText(times.start),
              name,
              unit,
              kind: gauge === undefined ? "sum" : "gauge",
              temporality: sum === undefined ? 0 : enumValue(sum, "aggregationTemporality", 2),
              monotonic: sum === undefined ? false : bool(sum, "isMonotonic"),
              value,
              attributes,
              dropped_attributes_count: droppedCount(point, dropped),
            };
            sharedBytes += resource.bytes;
            points.push({
              ...row,
              resource_attributes: resource.attributes,
              id: contentId(resource, row),
            });
          }
        } else if (histogram !== undefined) {
          const temporality = enumValue(histogram, "aggregationTemporality", 2);
          for (const point of messages(histogram, "dataPoints")) {
            records += 1;
            const times = pointTimes(point, context);
            if ("problem" in times) {
              refusals.add(times.problem);
              continue;
            }
            if ((int32(point, "flags") & NO_RECORDED_VALUE) !== 0) {
              refusals.add("data points without a value");
              continue;
            }
            // Check lengths before conversion to prevent huge arrays from exhausting the heap.
            const sentBounds = list(point, "explicitBounds");
            const sentCounts = list(point, "bucketCounts");
            if (sentBounds.length > MAX_HISTOGRAM_BOUNDS) {
              refusals.add(`histograms with more than ${MAX_HISTOGRAM_BOUNDS} bucket bounds`);
              continue;
            }
            if (sentCounts.length !== 0 && sentCounts.length !== sentBounds.length + 1) {
              refusals.add("histograms whose bucket counts do not match their bounds");
              continue;
            }
            const bounds = sentBounds.map((bound) => doubleOf(bound, "explicitBounds"));
            const counts = sentCounts.map((count) => {
              const value = int64Of(count, "bucketCounts");
              if (value < 0n || value > MAX_UINT64) {
                throw new MalformedError(
                  "bucketCounts holds a count that is not an unsigned 64-bit integer",
                );
              }
              return value.toString();
            });
            if (!bounds.every(Number.isFinite)) {
              refusals.add("histograms whose bucket counts do not match their bounds");
              continue;
            }
            const total = uint64(point, "count");
            if (
              total > MAX_HISTOGRAM_COUNT ||
              counts.some((count) => BigInt(count) > MAX_HISTOGRAM_COUNT)
            ) {
              refusals.add("histograms with a count of 2^63 or more");
              continue;
            }
            const { attributes, dropped } = flattenAttributes(messages(point, "attributes"));
            const row: Omit<HistogramRow, "id" | "resource_attributes"> = {
              ...shared,
              timestamp: nanosText(times.time),
              start_timestamp: nanosText(times.start),
              name,
              unit,
              temporality,
              count: total.toString(),
              sum: finiteOrNull(double(point, "sum")),
              min: finiteOrNull(double(point, "min")),
              max: finiteOrNull(double(point, "max")),
              bounds,
              bucket_counts: counts,
              attributes,
              dropped_attributes_count: droppedCount(point, dropped),
            };
            sharedBytes += resource.bytes;
            histograms.push({
              ...row,
              resource_attributes: resource.attributes,
              id: contentId(resource, row),
            });
          }
        } else if (unsupported !== undefined) {
          // Protobuf exponential histograms remain bytes (proto/definitions.ts).
          const count =
            unsupported instanceof Uint8Array
              ? countFields(unsupported, 1)
              : messages(unsupported, "dataPoints").length;
          records += count;
          refusals.add("exponential histograms and summaries are not supported yet", count);
        }
      }
    }
  }
  return { points, histograms, ...refusals.outcome(records, "data points", sharedBytes) };
}
