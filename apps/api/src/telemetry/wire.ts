import { Buffer } from "node:buffer";

import protobuf from "protobufjs";

import { STATUS_MESSAGE, type SignalMessages } from "./proto/definitions.ts";
import { MalformedError } from "./read.ts";

/**
 * The messages one request may decode into (records, attributes, their
 * values, and what holds them), and the elements of its lists of numbers
 * (a histogram's bounds and counts). Decoding allocates for each, and an empty
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

/**
 * A field that counts: one holding a message, or a repeated scalar, each
 * element of which decoding allocates for. A packed list's elements are
 * `size` bytes each, or varints when it is 0; a repeated string's or
 * bytes' (null) one per occurrence.
 */
type CountedField = { message: protobuf.Type } | { size: 0 | 4 | 8 | null };

const FIXED_SIZES: Record<string, 4 | 8> = {
  double: 8,
  fixed64: 8,
  sfixed64: 8,
  float: 4,
  fixed32: 4,
  sfixed32: 4,
};

/** For each message type, its fields that count: field number → how. */
const countedFields = new WeakMap<protobuf.Type, Map<number, CountedField>>();

function countedFieldsOf(type: protobuf.Type): Map<number, CountedField> {
  let fields = countedFields.get(type);
  if (fields === undefined) {
    fields = new Map();
    for (const field of type.fieldsArray) {
      if (field.resolvedType instanceof protobuf.Type) {
        fields.set(field.id, { message: field.resolvedType });
      } else if (field.repeated) {
        const fixed = FIXED_SIZES[field.type];
        const text = field.type === "string" || field.type === "bytes";
        fields.set(field.id, { size: fixed ?? (text ? null : 0) });
      }
    }
    countedFields.set(type, fields);
  }
  return fields;
}

/**
 * The messages a protobuf body decodes into, counted from the wire format
 * without decoding it or allocating: the body's own message, each
 * length-delimited field the definitions give a message type, at any depth,
 * and each element of a repeated scalar field, packed or not.
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
  const add = (elements: number) => {
    count += elements;
    if (count > max) throw new TooManyMessagesError(`more than ${max} messages`);
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
    const counted = countedFieldsOf(current.type).get(Math.floor(tag / 8));
    if (wireType === 2) {
      const length = varint();
      const end = position + length;
      if (end > current.end) throw malformed();
      if (counted !== undefined && "message" in counted) {
        add(1);
        if (open.length >= MAX_DEPTH) throw malformed();
        open.push({ type: counted.message, end });
        continue;
      }
      if (counted?.size === null) add(1);
      else if (counted?.size === 0) {
        let varints = 0;
        for (let at = position; at < end; at += 1) if ((body[at] ?? 0) < 0x80) varints += 1;
        add(varints);
      } else if (counted !== undefined) add(Math.ceil(length / counted.size));
      position = end;
      continue;
    }
    if (wireType === 0) varint();
    else if (wireType === 1) position += 8;
    else if (wireType === 5) position += 4;
    // Groups (3, 4) are not in OTLP; 6 and 7 are not wire types.
    else throw malformed();
    // A repeated scalar's element, sent unpacked.
    if (counted !== undefined && !("message" in counted)) add(1);
    if (position > current.end) throw malformed();
  }
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const COMMA = 0x2c;
const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);

/**
 * The objects, arrays, and other array elements a JSON body parses into,
 * counted from its bytes without parsing: each { and [ outside a string,
 * and each value in an array that is neither. UTF-8 never puts these bytes
 * inside another character. Throws TooManyMessagesError past `max`.
 */
export function countJsonContainers(body: Uint8Array, max = MAX_MESSAGES): number {
  let count = 0;
  let inString = false;
  // Whether each open container is an array.
  const arrays: boolean[] = [];
  // Whether the next value starts an element of an array.
  let element = false;
  const add = () => {
    count += 1;
    if (count > max) throw new TooManyMessagesError(`more than ${max} objects and arrays`);
  };
  for (let index = 0; index < body.length; index += 1) {
    const byte = body[index] ?? 0;
    if (inString) {
      if (byte === BACKSLASH) index += 1;
      else if (byte === QUOTE) inString = false;
      continue;
    }
    if (WHITESPACE.has(byte)) continue;
    const starts = element;
    element = false;
    if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
      add();
      arrays.push(byte === OPEN_BRACKET);
      element = byte === OPEN_BRACKET;
    } else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
      arrays.pop();
    } else if (byte === COMMA) {
      element = arrays.at(-1) === true;
    } else if (starts) {
      // A string, number, true, false, or null in an array.
      add();
      if (byte === QUOTE) inString = true;
    } else if (byte === QUOTE) {
      inString = true;
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
