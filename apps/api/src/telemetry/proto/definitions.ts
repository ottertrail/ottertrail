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
const root = new protobuf.Root();
for (const source of [
  COMMON_PROTO,
  RESOURCE_PROTO,
  TRACE_PROTO,
  LOGS_PROTO,
  METRICS_PROTO,
  TRACE_SERVICE_PROTO,
  LOGS_SERVICE_PROTO,
  METRICS_SERVICE_PROTO,
  STATUS_PROTO,
]) {
  protobuf.parse(source, root);
}
root.resolveAll();

export interface SignalMessages {
  request: protobuf.Type;
  response: protobuf.Type;
}

const COLLECTOR = "opentelemetry.proto.collector";

export const TRACE_MESSAGES: SignalMessages = {
  request: root.lookupType(`${COLLECTOR}.trace.v1.ExportTraceServiceRequest`),
  response: root.lookupType(`${COLLECTOR}.trace.v1.ExportTraceServiceResponse`),
};

export const LOGS_MESSAGES: SignalMessages = {
  request: root.lookupType(`${COLLECTOR}.logs.v1.ExportLogsServiceRequest`),
  response: root.lookupType(`${COLLECTOR}.logs.v1.ExportLogsServiceResponse`),
};

export const METRICS_MESSAGES: SignalMessages = {
  request: root.lookupType(`${COLLECTOR}.metrics.v1.ExportMetricsServiceRequest`),
  response: root.lookupType(`${COLLECTOR}.metrics.v1.ExportMetricsServiceResponse`),
};

/** An error answer's body (proto/status.ts). */
export const STATUS_MESSAGE = root.lookupType("google.rpc.Status");
