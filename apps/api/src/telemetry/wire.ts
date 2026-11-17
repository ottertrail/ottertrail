import { Buffer } from "node:buffer";

import protobuf from "protobufjs";

import { STATUS_MESSAGE, type SignalMessages } from "./proto/definitions.ts";
import { MalformedError } from "./read.ts";

/**
 * The messages one request may decode into (records, attributes, their
 * values, and what holds them). Decoding allocates for each, and an empty
 * one costs two bytes, so 16 MiB of them would take gigabytes; this many
 * take about as long and as much memory as decoding a large real batch
 * (20,000 spans of 20 attributes, about 820,000 messages). A Collector's
 * default batch, 8,192 spans, is about a third of it.
 */
export const MAX_MESSAGES = 1_000_000;

/** A request holds more than MAX_MESSAGES messages: the answer is 413. */
export class TooManyMessagesError extends Error {
  override name = "TooManyMessagesError";
}

/** How deep messages nest: protobufjs refuses past 100, as protoc does. */
const MAX_DEPTH = 100;

function malformed(): MalformedError {
  return new MalformedError("The body is not an OTLP protobuf message.");
}

/** For each message type, its fields that hold messages: field number → the field's type. */
const messageFields = new WeakMap<protobuf.Type, Map<number, protobuf.Type>>();

function messageFieldsOf(type: protobuf.Type): Map<number, protobuf.Type> {
  let fields = messageFields.get(type);
  if (fields === undefined) {
    fields = new Map();
    for (const field of type.fieldsArray) {
      if (field.resolvedType instanceof protobuf.Type) fields.set(field.id, field.resolvedType);
    }
    messageFields.set(type, fields);
  }
  return fields;
}

/**
 * The messages a protobuf body decodes into, counted from the wire format
 * without decoding it or allocating: the body's own message, and each
 * length-delimited field the definitions give a message type, at any depth.
 * Throws TooManyMessagesError past `max`, MalformedError for a body that
 * is not protobuf.
 */
export function countProtobufMessages(
  type: protobuf.Type,
  body: Uint8Array,
  max = MAX_MESSAGES,
): number {
  let count = 1;
  let position = 0;
  const varint = (): number => {
    let value = 0;
    for (let shift = 0; shift < 64; shift += 7) {
      const byte = body[position];
      if (byte === undefined) throw malformed();
      position += 1;
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
    }
    throw malformed();
  };
  // Each open message: its type, and where it ends.
  const open: { type: protobuf.Type; end: number }[] = [{ type, end: body.length }];
  for (;;) {
    const current = open.at(-1);
    if (current === undefined) return count;
    if (position === current.end) {
      open.pop();
      continue;
    }
    const tag = varint();
    const wireType = tag % 8;
    if (wireType === 0) varint();
    else if (wireType === 1) position += 8;
    else if (wireType === 5) position += 4;
    else if (wireType === 2) {
      const length = varint();
      const end = position + length;
      if (end > current.end) throw malformed();
      const child = messageFieldsOf(current.type).get(Math.floor(tag / 8));
      if (child === undefined) {
        position = end;
      } else {
        count += 1;
        if (count > max) throw new TooManyMessagesError(`more than ${max} messages`);
        if (open.length >= MAX_DEPTH) throw malformed();
        open.push({ type: child, end });
      }
    } else {
      // Groups (3, 4) are not in OTLP; 6 and 7 are not wire types.
      throw malformed();
    }
    if (position > current.end) throw malformed();
  }
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const OPEN_BRACKET = 0x5b;

/**
 * The objects and arrays a JSON body parses into, counted from its bytes
 * without parsing: each { and [ outside a string. UTF-8 never puts these
 * bytes inside another character. Throws TooManyMessagesError past `max`.
 */
export function countJsonContainers(body: Uint8Array, max = MAX_MESSAGES): number {
  let count = 0;
  let inString = false;
  for (let index = 0; index < body.length; index += 1) {
    const byte = body[index];
    if (inString) {
      if (byte === BACKSLASH) index += 1;
      else if (byte === QUOTE) inString = false;
    } else if (byte === QUOTE) {
      inString = true;
    } else if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
      count += 1;
      if (count > max) throw new TooManyMessagesError(`more than ${max} objects and arrays`);
    }
  }
  return count;
}

/** What a body decodes into, counted before decoding it: see the two functions above. */
export function countMessages(
  messages: SignalMessages,
  body: Uint8Array,
  encoding: Encoding,
  max = MAX_MESSAGES,
): number {
  return encoding === "protobuf"
    ? countProtobufMessages(messages.request, body, max)
    : countJsonContainers(body, max);
}

/** OTLP/HTTP's two encodings: an answer comes in the request's. */
export type Encoding = "protobuf" | "json";

export const CONTENT_TYPES: Record<Encoding, string> = {
  protobuf: "application/x-protobuf",
  json: "application/json",
};

/** The encoding a Content-Type names, or null for one OTLP does not use. */
export function encodingOf(contentType: string | undefined): Encoding | null {
  const type = (contentType ?? "").split(";", 1)[0]?.trim().toLowerCase();
  if (type === CONTENT_TYPES.protobuf) return "protobuf";
  if (type === CONTENT_TYPES.json) return "json";
  return null;
}

/**
 * An Export…ServiceRequest, decoded into the shape read.ts reads: from
 * protobuf with 64-bit numbers as bigint and bytes as Buffers, from JSON as
 * it is. Throws MalformedError when the body is not the encoding it says.
 */
export function decodeRequest(messages: SignalMessages, body: Buffer, encoding: Encoding): object {
  if (encoding === "protobuf") {
    try {
      return messages.request.toObject(messages.request.decode(body), { longs: BigInt });
    } catch (error) {
      throw new MalformedError("The body is not an OTLP protobuf message.", { cause: error });
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch (error) {
    throw new MalformedError("The body is not JSON.", { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new MalformedError("The body is not a JSON object.");
  }
  return parsed;
}

/** A message in the given encoding: protobuf bytes, or OTLP's JSON (64-bit numbers as text). */
export function encodeMessage(
  type: SignalMessages["response"],
  value: object,
  encoding: Encoding,
): Buffer | string {
  const message = type.fromObject(value);
  if (encoding === "protobuf") {
    const bytes = type.encode(message).finish();
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  return JSON.stringify(type.toObject(message, { longs: String, json: true }));
}

/**
 * google.rpc.Status codes (google/rpc/code.proto) for the HTTP statuses
 * these routes answer with.
 */
const RPC_CODES: Record<number, number> = {
  400: 3, // INVALID_ARGUMENT
  401: 16, // UNAUTHENTICATED
  413: 3,
  415: 3,
  429: 8, // RESOURCE_EXHAUSTED
  500: 13, // INTERNAL
  503: 14, // UNAVAILABLE
};

/** An error answer's body: a Status, as protobuf or as {"code","message"}. */
export function statusBody(httpStatus: number, text: string, encoding: Encoding): Buffer | string {
  return encodeMessage(
    STATUS_MESSAGE,
    { code: RPC_CODES[httpStatus] ?? 2, message: text },
    encoding,
  );
}
