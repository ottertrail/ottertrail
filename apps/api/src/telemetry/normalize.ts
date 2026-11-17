import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import {
  DEFAULT_ENVIRONMENT,
  ENVIRONMENT_PATTERN,
  RELEASE_PATTERN,
} from "../collection/environment.ts";
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

/**
 * OTLP requests, decoded (wire.ts), as rows of ClickHouse's telemetry
 * tables (migration 0007; docs/telemetry.md). Pure functions: the same
 * request, with the same project, always gives the same rows, so a retried
 * request stores rows ReplacingMergeTree keeps once. (A log record with no
 * time at all takes its arrival's, so a retry of it is stored again.)
 */

/** At most this many attributes a record keeps; the rest are dropped, and counted. */
export const MAX_ATTRIBUTES = 128;
/** Attribute keys are cut to this many characters. */
export const MAX_KEY_CHARS = 256;
/** Attribute values are cut to this many bytes. */
export const MAX_VALUE_BYTES = 4 * 1024;
/**
 * A resource's attributes, keys and values together, are cut to this many
 * bytes (in key order): every record of the resource carries a copy.
 */
export const MAX_RESOURCE_ATTRIBUTE_BYTES = 8 * 1024;
/** A span's name is cut to this many bytes. */
export const MAX_NAME_BYTES = 1024;
/** A log record's body is cut to this many bytes. */
export const MAX_BODY_BYTES = 64 * 1024;
/** At most this many events, and as many links, a span keeps; the rest are dropped, and counted. */
export const MAX_SPAN_EVENTS = 128;
export const MAX_SPAN_LINKS = 128;
/** Names such as a service's, a scope's, a severity, or a unit are cut to this many characters. */
const MAX_LABEL_CHARS = 256;
/** How deep a nested attribute value is written out; deeper parts are left out. */
const MAX_VALUE_DEPTH = 16;

const NANOS_PER_SECOND = 1_000_000_000n;
const NANOS_PER_DAY = 86_400n * NANOS_PER_SECOND;
/** How far ahead of the server's clock a record may be. */
const MAX_AHEAD_NS = 3600n * NANOS_PER_SECOND;
const MAX_UINT32 = 0xffff_ffff;
const MAX_UINT64 = 0xffff_ffff_ffff_ffffn;

const ENVIRONMENT = new RegExp(ENVIRONMENT_PATTERN);
const RELEASE = new RegExp(RELEASE_PATTERN);

export interface NormalizeContext {
  projectId: string;
  /** When the request arrived, in nanoseconds since 1970. */
  receivedAtNs: bigint;
  /** Days telemetry is kept: older records are refused. */
  retentionDays: number;
}

/** What every row of one resource and scope shares, but the resource's attributes. */
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

/** Records a request held, and those refused, with why. */
export interface Outcome {
  /** Spans, log records, or data points in the request, refused or not. */
  records: number;
  refused: number;
  /** Why records were refused, for partial_success; "" when none were. */
  message: string;
  /**
   * Bytes of resource attributes the rows repeat: each row's copy of its
   * resource's, which the request sent once.
   */
  sharedBytes: number;
}

/** Counts refused records and their reasons, each reason once. */
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

/** "2026-11-18 12:00:00.123456789": a DateTime64(9, 'UTC') as ClickHouse reads it. */
export function nanosText(ns: bigint): string {
  const seconds = ns / NANOS_PER_SECOND;
  const fraction = ns % NANOS_PER_SECOND;
  const whole = new Date(Number(seconds) * 1000).toISOString().slice(0, 19).replace("T", " ");
  return `${whole}.${fraction.toString().padStart(9, "0")}`;
}

/** Text cut to `max` bytes of UTF-8, never inside a character; unpaired surrogates replaced. */
export function cutBytes(value: string, max: number): string {
  const wellFormed = value.toWellFormed();
  // Fast path: a UTF-16 unit is at most 3 bytes of UTF-8.
  if (wellFormed.length * 3 <= max || Buffer.byteLength(wellFormed) <= max) return wellFormed;
  const cut = Buffer.from(wellFormed).subarray(0, max).toString("utf8");
  // A character split at the end decodes as U+FFFD: leave it out.
  return wellFormed.startsWith(cut) ? cut : cut.slice(0, -1);
}

/** Text cut to `max` UTF-16 units; a surrogate pair split at the end is replaced. */
export function cutChars(value: string, max: number): string {
  return (value.length <= max ? value : value.slice(0, max)).toWellFormed();
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** An AnyValue as JSON: integers beyond what a double holds exactly as text. */
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

/**
 * An AnyValue as text: a string as it is, a number or boolean as written,
 * bytes in hex, a list or a map as JSON, nothing as "".
 */
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

/** Map entries sorted by key, as an object: the same attributes always read the same. */
function sortedObject(map: Map<string, string>): Record<string, string> {
  return Object.fromEntries([...map].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * KeyValues as a map of text: at most MAX_ATTRIBUTES, keys cut to
 * MAX_KEY_CHARS, values to MAX_VALUE_BYTES. A repeated key keeps its last
 * value. `dropped` counts those left out.
 */
export function flattenAttributes(items: object[]): {
  attributes: Record<string, string>;
  dropped: number;
} {
  const attributes = new Map<string, string>();
  let dropped = 0;
  for (const item of items) {
    const key = cutChars(text(item, "key"), MAX_KEY_CHARS);
    if (!attributes.has(key) && attributes.size >= MAX_ATTRIBUTES) {
      dropped += 1;
      continue;
    }
    attributes.set(key, cutBytes(valueText(message(item, "value")), MAX_VALUE_BYTES));
  }
  return { attributes: sortedObject(attributes), dropped };
}

/** A count to store as UInt32: the sender's dropped count plus ours. */
function droppedCount(from: object, ours: number): number {
  return Math.min(MAX_UINT32, Math.max(0, int32(from, "droppedAttributesCount")) + ours);
}

/** An environment as the tracker's are stored: lower case, "production" when absent or invalid. */
export function environmentOfResource(attributes: Record<string, string>): string {
  const sent = attributes["deployment.environment.name"] ?? attributes["deployment.environment"];
  return sent !== undefined && ENVIRONMENT.test(sent) ? sent.toLowerCase() : DEFAULT_ENVIRONMENT;
}

/**
 * Attributes, in key order, while their keys and values together fit in
 * `max` bytes of UTF-8; the rest are left out.
 */
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

/** A resource: what its records share, read once for all of them. */
interface Resource {
  labels: Omit<Labels, "scope_name" | "scope_version">;
  /** Its attributes, at most MAX_RESOURCE_ATTRIBUTE_BYTES. */
  attributes: Record<string, string>;
  /** Their size: what each record's row repeats. */
  bytes: number;
  /** A hash of them, which records' content IDs take instead of the attributes themselves. */
  hash: string;
}

/** The resource's service, release, and environment (from all its attributes), and the attributes kept. */
function resourceOf(container: object, projectId: string): Resource {
  const resource = message(container, "resource");
  const { attributes: all } = flattenAttributes(
    resource === undefined ? [] : messages(resource, "attributes"),
  );
  const service = cutChars(all["service.name"] ?? "", MAX_LABEL_CHARS);
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
    scope_name: scope === undefined ? "" : cutChars(text(scope, "name"), MAX_LABEL_CHARS),
    scope_version: scope === undefined ? "" : cutChars(text(scope, "version"), MAX_LABEL_CHARS),
  };
}

/** Why a record's time cannot be stored, or null when it can. */
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
 * A stable ID from a row's content, without its resource's attributes, and
 * its resource's hash: the first 16 bytes of their SHA-256, in hex. Hashing
 * the attributes once per resource, not once per row, keeps a request's
 * cost to its own size.
 */
function contentId(resource: Resource, row: object): string {
  return createHash("sha256")
    .update(resource.hash)
    .update(JSON.stringify(row))
    .digest("hex")
    .slice(0, 32);
}

/** A field's value in an enum's range, or 0 (unspecified) when outside it. */
function enumValue(from: object, key: string, max: number): number {
  const value = int32(from, key);
  return value >= 0 && value <= max ? value : 0;
}

const ZERO_TRACE = "0".repeat(32);
const ZERO_SPAN = "0".repeat(16);

/** ExportTraceServiceRequest → spans rows. */
export function normalizeTraces(
  request: object,
  context: NormalizeContext,
): Outcome & { rows: SpanRow[] } {
  const rows: SpanRow[] = [];
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
        const { attributes, dropped } = flattenAttributes(messages(span, "attributes"));
        const events = messages(span, "events");
        const links = messages(span, "links");
        const status = message(span, "status");
        sharedBytes += resource.bytes;
        rows.push({
          ...shared,
          timestamp: nanosText(start),
          id: traceId + spanId,
          trace_id: traceId,
          span_id: spanId,
          parent_span_id: id(span, "parentSpanId", 8),
          name: cutBytes(text(span, "name"), MAX_NAME_BYTES),
          kind: enumValue(span, "kind", 5),
          duration_ns: (end - start).toString(),
          status_code: status === undefined ? 0 : enumValue(status, "code", 2),
          status_message:
            status === undefined ? "" : cutBytes(text(status, "message"), MAX_VALUE_BYTES),
          attributes,
          dropped_attributes_count: droppedCount(span, dropped),
          events: JSON.stringify(
            events.slice(0, MAX_SPAN_EVENTS).map((event) => ({
              time: uint64(event, "timeUnixNano").toString(),
              name: cutBytes(text(event, "name"), MAX_NAME_BYTES),
              attributes: flattenAttributes(messages(event, "attributes")).attributes,
            })),
          ),
          dropped_events_count: Math.min(
            MAX_UINT32,
            Math.max(0, int32(span, "droppedEventsCount")) +
              Math.max(0, events.length - MAX_SPAN_EVENTS),
          ),
          links: JSON.stringify(
            links.slice(0, MAX_SPAN_LINKS).map((link) => ({
              traceId: id(link, "traceId", 16),
              spanId: id(link, "spanId", 8),
              attributes: flattenAttributes(messages(link, "attributes")).attributes,
            })),
          ),
          dropped_links_count: Math.min(
            MAX_UINT32,
            Math.max(0, int32(span, "droppedLinksCount")) +
              Math.max(0, links.length - MAX_SPAN_LINKS),
          ),
        });
      }
    }
  }
  return { rows, ...refusals.outcome(records, "spans", sharedBytes) };
}

/** ExportLogsServiceRequest → logs rows. */
export function normalizeLogs(
  request: object,
  context: NormalizeContext,
): Outcome & { rows: LogRow[] } {
  const rows: LogRow[] = [];
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
        // When it happened; failing that, when a collector saw it; failing that, now.
        const at = time !== 0n ? time : observed !== 0n ? observed : context.receivedAtNs;
        const problem = timeProblem(at, context);
        if (problem !== null) {
          refusals.add(problem);
          continue;
        }
        const { attributes, dropped } = flattenAttributes(messages(record, "attributes"));
        const row: Omit<LogRow, "id" | "resource_attributes"> = {
          ...shared,
          timestamp: nanosText(at),
          observed_timestamp: nanosText(
            observed !== 0n && observed <= context.receivedAtNs + MAX_AHEAD_NS ? observed : at,
          ),
          severity_number: enumValue(record, "severityNumber", 24),
          severity_text: cutChars(text(record, "severityText"), MAX_LABEL_CHARS),
          body: cutBytes(valueText(message(record, "body")), MAX_BODY_BYTES),
          trace_id: id(record, "traceId", 16),
          span_id: id(record, "spanId", 8),
          event_name: cutChars(text(record, "eventName"), MAX_LABEL_CHARS),
          attributes,
          dropped_attributes_count: droppedCount(record, dropped),
        };
        sharedBytes += resource.bytes;
        rows.push({
          ...row,
          resource_attributes: resource.attributes,
          id: contentId(resource, row),
        });
      }
    }
  }
  return { rows, ...refusals.outcome(records, "log records", sharedBytes) };
}

/** OTLP's DataPointFlags: the point marks a missing value, not a value. */
const NO_RECORDED_VALUE = 1;

/** A data point's times, or why it is refused. */
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

/** A histogram's sum, minimum, or maximum: null when absent or not a finite number. */
function finiteOrNull(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) ? value : null;
}

/** ExportMetricsServiceRequest → metric_points and metric_histograms rows. */
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
        const unit = cutChars(text(metric, "unit"), MAX_LABEL_CHARS);
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
            const bounds = list(point, "explicitBounds").map((bound) =>
              doubleOf(bound, "explicitBounds"),
            );
            const counts = list(point, "bucketCounts").map((count) => {
              const value = int64Of(count, "bucketCounts");
              if (value < 0n || value > MAX_UINT64) {
                throw new MalformedError(
                  "bucketCounts holds a count that is not an unsigned 64-bit integer",
                );
              }
              return value.toString();
            });
            if (
              (counts.length !== 0 && counts.length !== bounds.length + 1) ||
              !bounds.every(Number.isFinite)
            ) {
              refusals.add("histograms whose bucket counts do not match their bounds");
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
              count: uint64(point, "count").toString(),
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
          const count = messages(unsupported, "dataPoints").length;
          records += count;
          refusals.add("exponential histograms and summaries are not supported yet", count);
        }
      }
    }
  }
  return { points, histograms, ...refusals.outcome(records, "data points", sharedBytes) };
}
