import { Buffer } from "node:buffer";

/**
 * Reading an OTLP request, decoded from either encoding into the same
 * shape: field names in lowerCamelCase, as OTLP's JSON has them.
 *
 * - From protobuf (wire.ts), 64-bit numbers arrive as bigint and bytes
 *   as Buffers.
 * - From JSON, 64-bit numbers arrive as decimal strings or numbers, trace
 *   and span IDs as hex, other bytes as base64, enums as numbers, and
 *   fields the definitions do not have are ignored.
 *
 * A value of the wrong type throws MalformedError: the request is not
 * OTLP, and the answer is 400.
 */
export class MalformedError extends Error {
  override name = "MalformedError";
}

/** An own property, so a key such as "__proto__" never reads the prototype. */
function get(from: object, key: string): unknown {
  if (!Object.hasOwn(from, key)) return undefined;
  const value: unknown = Reflect.get(from, key);
  return value;
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A nested message; undefined when absent. */
export function message(from: object, key: string): object | undefined {
  const value = get(from, key);
  if (value === undefined || value === null) return undefined;
  if (!isObject(value)) throw new MalformedError(`${key} is not an object`);
  return value;
}

/** A repeated field of messages; empty when absent. */
export function messages(from: object, key: string): object[] {
  return list(from, key).map((item) => {
    if (!isObject(item)) throw new MalformedError(`${key} holds something not an object`);
    return item;
  });
}

/** A repeated field; empty when absent. */
export function list(from: object, key: string): unknown[] {
  const value = get(from, key);
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new MalformedError(`${key} is not a list`);
  return value;
}

export function text(from: object, key: string): string {
  const value = get(from, key);
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new MalformedError(`${key} is not a string`);
  return value;
}

export function bool(from: object, key: string): boolean {
  const value = get(from, key);
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new MalformedError(`${key} is not a boolean`);
  return value;
}

const INTEGER = /^-?\d{1,20}$/;

/** A 64-bit integer: bigint (protobuf), a decimal string, or a whole number (JSON). */
export function int64Of(value: unknown, key: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && INTEGER.test(value)) return BigInt(value);
  throw new MalformedError(`${key} is not an integer`);
}

/** A 64-bit integer field; 0 when absent. */
export function int64(from: object, key: string): bigint {
  const value = get(from, key);
  return value === undefined || value === null ? 0n : int64Of(value, key);
}

/** A 32-bit integer or an enum, as a number; 0 when absent. */
export function int32(from: object, key: string): number {
  const value = get(from, key);
  if (value === undefined || value === null) return 0;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d{1,10}$/.test(value)) return Number(value);
  throw new MalformedError(`${key} is not an integer`);
}

/** A double: a number, or in JSON "NaN", "Infinity", "-Infinity", or a numeric string. */
export function doubleOf(value: unknown, key: string): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    if (value === "NaN") return Number.NaN;
    if (value === "Infinity") return Number.POSITIVE_INFINITY;
    if (value === "-Infinity") return Number.NEGATIVE_INFINITY;
    const number = Number(value);
    if (value.trim() !== "" && !Number.isNaN(number)) return number;
  }
  throw new MalformedError(`${key} is not a number`);
}

/** A double field; undefined when absent (OTLP's optional sum, min, and max). */
export function double(from: object, key: string): number | undefined {
  const value = get(from, key);
  return value === undefined || value === null ? undefined : doubleOf(value, key);
}

/** Whether the field is present: which member of a oneof was sent. */
export function has(from: object, key: string): boolean {
  const value = get(from, key);
  return value !== undefined && value !== null;
}

/** The raw value of a field, for a oneof read by its member. */
export function field(from: object, key: string): unknown {
  return get(from, key);
}

const HEX = /^(?:[0-9a-fA-F]{2})*$/;
const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/;

/**
 * A trace or span ID as lower-case hex: `length` bytes, or "" when absent
 * or empty. OTLP's JSON sends these in hex, protobuf as bytes.
 */
export function id(from: object, key: string, length: number): string {
  const value = get(from, key);
  if (value === undefined || value === null) return "";
  let hex: string;
  if (value instanceof Uint8Array) {
    hex = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("hex");
  } else if (typeof value === "string" && HEX.test(value)) {
    hex = value.toLowerCase();
  } else {
    throw new MalformedError(`${key} is not a hex ID`);
  }
  if (hex.length !== 0 && hex.length !== length * 2) {
    throw new MalformedError(`${key} is not ${length} bytes`);
  }
  return hex;
}

/** An unsigned 64-bit integer field, such as a count; 0 when absent. */
export function uint64(from: object, key: string): bigint {
  const value = int64(from, key);
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new MalformedError(`${key} is not an unsigned 64-bit integer`);
  }
  return value;
}

/** A bytes value other than an ID: a Buffer (protobuf), or base64 (JSON). */
export function bytesOf(value: unknown, key: string): Buffer {
  if (value instanceof Uint8Array)
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === "string" && BASE64.test(value)) return Buffer.from(value, "base64");
  throw new MalformedError(`${key} is not base64`);
}
