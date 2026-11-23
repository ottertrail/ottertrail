import { Buffer } from "node:buffer";

import protobuf from "protobufjs";

import { STATUS_MESSAGE, type SignalMessages } from "./proto/definitions.ts";
import { MalformedError } from "./read.ts";

/**
 * Decoding allocates per message; empty messages need only two wire bytes, so 16 MiB could
 * allocate gigabytes. This cap covers about 20,000 spans with 20 attributes (820,000 messages). A
 * Collector's default 8,192-span batch is about a third.
 */
export const MAX_MESSAGES = 1_000_000;

/**
 * Counts four doubles, floats, or 32-bit integers as one message: decoded elements use about 32
 * bytes versus about 100 per message. Each 64-bit integer or string counts as one message. JSON
 * elements count a quarter because JSON.parse creates no BigInts.
 */
export const ELEMENTS_PER_MESSAGE = 4;

/** Maps to HTTP 413. */
export class TooManyMessagesError extends Error {
  override name = "TooManyMessagesError";
}

/** Matches protobufjs and protoc nesting limits. */
const MAX_DEPTH = 100;

function malformed(): MalformedError {
  return new MalformedError("The body is not an OTLP protobuf message.");
}

/**
 * Repeated scalars weigh `quarters` per element. Packed elements use `size` bytes or varints (0);
 * strings and bytes (null) count per occurrence.
 */
type CountedField = { message: protobuf.Type } | { size: 0 | 4 | 8 | null; quarters: 1 | 4 };

/** Long then BigInt decoding costs about as much as a message. */
const WIDE_INTEGERS = new Set(["fixed64", "sfixed64", "uint64", "int64", "sint64"]);

const FIXED_SIZES: Record<string, 4 | 8> = {
  double: 8,
  fixed64: 8,
  sfixed64: 8,
  float: 4,
  fixed32: 4,
  sfixed32: 4,
};

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
        fields.set(field.id, {
          size: fixed ?? (text ? null : 0),
          quarters: text || WIDE_INTEGERS.has(field.type) ? 4 : 1,
        });
      }
    }
    countedFields.set(type, fields);
  }
  return fields;
}

/**
 * Counts the root, nested messages, and repeated scalars before decoding. Throws
 * TooManyMessagesError past `max` and MalformedError for invalid protobuf.
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
  /** Quarter-message units. */
  let quarters = 0;
  const total = () => count + Math.ceil(quarters / ELEMENTS_PER_MESSAGE);
  const add = (messages: number) => {
    count += messages;
    if (total() > max) throw new TooManyMessagesError(`more than ${max} messages`);
  };
  const addElements = (found: number, weight: number) => {
    quarters += found * weight;
    if (total() > max) throw new TooManyMessagesError(`more than ${max} messages`);
  };
  const open: { type: protobuf.Type; end: number }[] = [{ type, end: body.length }];
  for (;;) {
    const current = open.at(-1);
    if (current === undefined) return total();
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
      if (counted?.size === null) addElements(1, counted.quarters);
      else if (counted?.size === 0) {
        let varints = 0;
        for (let at = position; at < end; at += 1) if ((body[at] ?? 0) < 0x80) varints += 1;
        addElements(varints, counted.quarters);
      } else if (counted !== undefined) {
        addElements(Math.ceil(length / counted.size), counted.quarters);
      }
      position = end;
      continue;
    }
    if (wireType === 0) varint();
    else if (wireType === 1) position += 8;
    else if (wireType === 5) position += 4;
    // Groups (3, 4) are not in OTLP; 6 and 7 are not wire types.
    else throw malformed();
    if (counted !== undefined && !("message" in counted)) addElements(1, counted.quarters);
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
 * Counts containers plus scalar array elements at ELEMENTS_PER_MESSAGE to one before parsing.
 * UTF-8 cannot embed these structural bytes in other characters. Throws TooManyMessagesError past
 * `max`.
 */
export function countJsonContainers(body: Uint8Array, max = MAX_MESSAGES): number {
  let count = 0;
  let inString = false;
  const arrays: boolean[] = [];
  let element = false;
  let elements = 0;
  const total = () => count + Math.ceil(elements / ELEMENTS_PER_MESSAGE);
  const check = () => {
    if (total() > max) throw new TooManyMessagesError(`more than ${max} objects and arrays`);
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
      count += 1;
      check();
      arrays.push(byte === OPEN_BRACKET);
      element = byte === OPEN_BRACKET;
    } else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
      arrays.pop();
    } else if (byte === COMMA) {
      element = arrays.at(-1) === true;
    } else if (starts) {
      elements += 1;
      check();
      if (byte === QUOTE) inString = true;
    } else if (byte === QUOTE) {
      inString = true;
    }
  }
  return total();
}

/**
 * Counts occurrences of an outer field without decoding exponential histogram data points
 * (proto/definitions.ts). Throws MalformedError for invalid bytes.
 */
export function countFields(bytes: Uint8Array, number: number): number {
  let count = 0;
  let position = 0;
  const varint = (): number => {
    let value = 0;
    for (let shift = 0; shift < 64; shift += 7) {
      const byte = bytes[position];
      if (byte === undefined) throw malformed();
      position += 1;
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
    }
    throw malformed();
  };
  while (position < bytes.length) {
    const tag = varint();
    if (Math.floor(tag / 8) === number) count += 1;
    const wireType = tag % 8;
    if (wireType === 0) varint();
    else if (wireType === 1) position += 8;
    else if (wireType === 5) position += 4;
    else if (wireType === 2) {
      const length = varint();
      position += length;
    } else throw malformed();
    if (position > bytes.length) throw malformed();
  }
  return count;
}

export function countMessages(
  messages: SignalMessages,
  body: Uint8Array,
  encoding: Encoding,
  max = MAX_MESSAGES,
): number {
  return encoding === "protobuf"
    ? countProtobufMessages(messages.decoding, body, max)
    : countJsonContainers(body, max);
}

/** Responses use the request encoding. */
export type Encoding = "protobuf" | "json";

export const CONTENT_TYPES: Record<Encoding, string> = {
  protobuf: "application/x-protobuf",
  json: "application/json",
};

/** Returns null for unsupported content types. */
export function encodingOf(contentType: string | undefined): Encoding | null {
  const type = (contentType ?? "").split(";", 1)[0]?.trim().toLowerCase();
  if (type === CONTENT_TYPES.protobuf) return "protobuf";
  if (type === CONTENT_TYPES.json) return "json";
  return null;
}

/**
 * Protobuf yields bigint and Buffers; JSON is unchanged (read.ts). Throws MalformedError for
 * invalid bodies.
 */
export function decodeRequest(messages: SignalMessages, body: Buffer, encoding: Encoding): object {
  if (encoding === "protobuf") {
    try {
      return messages.decoding.toObject(messages.decoding.decode(body), { longs: BigInt });
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

/** JSON encodes 64-bit integers as text. */
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

/** google.rpc.Status codes from google/rpc/code.proto. */
const RPC_CODES: Record<number, number> = {
  400: 3, // INVALID_ARGUMENT
  401: 16, // UNAUTHENTICATED
  413: 3,
  415: 3,
  429: 8, // RESOURCE_EXHAUSTED
  500: 13, // INTERNAL
  503: 14, // UNAVAILABLE
};

export function statusBody(httpStatus: number, text: string, encoding: Encoding): Buffer | string {
  return encodeMessage(
    STATUS_MESSAGE,
    { code: RPC_CODES[httpStatus] ?? 2, message: text },
    encoding,
  );
}
