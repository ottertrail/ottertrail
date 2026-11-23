import protobuf from "protobufjs";

import { COMMON_PROTO } from "./common.ts";
import { LOGS_SERVICE_PROTO } from "./logs-service.ts";
import { LOGS_PROTO } from "./logs.ts";
import { METRICS_SERVICE_PROTO } from "./metrics-service.ts";
import { METRICS_PROTO } from "./metrics.ts";
import { RESOURCE_PROTO } from "./resource.ts";
import { STATUS_PROTO } from "./status.ts";
import { TRACE_SERVICE_PROTO } from "./trace-service.ts";
import { TRACE_PROTO } from "./trace.ts";

/**
 * The OTLP messages, parsed once from the vendored definitions
 * (opentelemetry-proto v1.11.1). Fields are named in lowerCamelCase, as
 * OTLP's JSON names them, so both encodings decode to the same shape.
 */
function rootOf(metrics: string): protobuf.Root {
  const parsed = new protobuf.Root();
  for (const source of [
    COMMON_PROTO,
    RESOURCE_PROTO,
    TRACE_PROTO,
    LOGS_PROTO,
    metrics,
    TRACE_SERVICE_PROTO,
    LOGS_SERVICE_PROTO,
    METRICS_SERVICE_PROTO,
    STATUS_PROTO,
  ]) {
    protobuf.parse(source, parsed);
  }
  parsed.resolveAll();
  return parsed;
}

const root = rootOf(METRICS_PROTO);

/**
 * The same, but an exponential histogram is left as its bytes: Ottertrail
 * refuses those points (normalize.ts), and decoded, their bucket counts
 * would each be a BigInt, so 4 MB of them would take 400 MB. As bytes, it
 * is a view of the body, and counts as one message (wire.ts).
 */
const decodingRoot = rootOf(
  METRICS_PROTO.replace(
    "ExponentialHistogram exponential_histogram = 10;",
    "bytes exponential_histogram = 10;",
  ),
);

export interface SignalMessages {
  request: protobuf.Type;
  /** What a request is counted and decoded as: `request`, or for metrics, decodingRoot's. */
  decoding: protobuf.Type;
  response: protobuf.Type;
}

const COLLECTOR = "opentelemetry.proto.collector";

export const TRACE_MESSAGES: SignalMessages = {
  request: root.lookupType(`${COLLECTOR}.trace.v1.ExportTraceServiceRequest`),
  decoding: root.lookupType(`${COLLECTOR}.trace.v1.ExportTraceServiceRequest`),
  response: root.lookupType(`${COLLECTOR}.trace.v1.ExportTraceServiceResponse`),
};

export const LOGS_MESSAGES: SignalMessages = {
  request: root.lookupType(`${COLLECTOR}.logs.v1.ExportLogsServiceRequest`),
  decoding: root.lookupType(`${COLLECTOR}.logs.v1.ExportLogsServiceRequest`),
  response: root.lookupType(`${COLLECTOR}.logs.v1.ExportLogsServiceResponse`),
};

export const METRICS_MESSAGES: SignalMessages = {
  request: root.lookupType(`${COLLECTOR}.metrics.v1.ExportMetricsServiceRequest`),
  decoding: decodingRoot.lookupType(`${COLLECTOR}.metrics.v1.ExportMetricsServiceRequest`),
  response: root.lookupType(`${COLLECTOR}.metrics.v1.ExportMetricsServiceResponse`),
};

/** An error answer's body (proto/status.ts). */
export const STATUS_MESSAGE = root.lookupType("google.rpc.Status");
