import { Buffer } from "node:buffer";

/**
 * Both encodings use lowerCamelCase fields. Protobuf uses bigint and Buffers; JSON uses decimal
 * strings or numbers for 64-bit integers, hex IDs, base64 bytes, and numeric enums. Unknown fields
 * are ignored. Wrong types cause a 400.
 */
export class MalformedError extends Error {
  override name = "MalformedError";
}

/** Only own properties, so "__proto__" cannot read the prototype. */
function get(from: object, key: string): unknown {
  if (!Object.hasOwn(from, key)) return undefined;
  const value: unknown = Reflect.get(from, key);
  return value;
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns undefined when absent. */
export function message(from: object, key: string): object | undefined {
  const value = get(from, key);
  if (value === undefined || value === null) return undefined;
  if (!isObject(value)) throw new MalformedError(`${key} is not an object`);
  return value;
}

/** Returns an empty list when absent. */
export function messages(from: object, key: string): object[] {
  return list(from, key).map((item) => {
    if (!isObject(item)) throw new MalformedError(`${key} holds something not an object`);
    return item;
  });
}

/** Returns an empty list when absent. */
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

/** Accepts bigint, decimal strings, and whole numbers. */
export function int64Of(value: unknown, key: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && INTEGER.test(value)) return BigInt(value);
  throw new MalformedError(`${key} is not an integer`);
}

/** Defaults to 0 when absent. */
export function int64(from: object, key: string): bigint {
  const value = get(from, key);
  return value === undefined || value === null ? 0n : int64Of(value, key);
}

/** Accepts integers and enums. Defaults to 0 when absent. */
export function int32(from: object, key: string): number {
  const value = get(from, key);
  if (value === undefined || value === null) return 0;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d{1,10}$/.test(value)) return Number(value);
  throw new MalformedError(`${key} is not an integer`);
}

/** Accepts numbers and numeric strings, including "NaN", "Infinity", and "-Infinity". */
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

/** Returns undefined for absent OTLP sum, min, and max fields. */
export function double(from: object, key: string): number | undefined {
  const value = get(from, key);
  return value === undefined || value === null ? undefined : doubleOf(value, key);
}

/** Tests which oneof member was sent. */
export function has(from: object, key: string): boolean {
  const value = get(from, key);
  return value !== undefined && value !== null;
}

export function field(from: object, key: string): unknown {
  return get(from, key);
}

const HEX = /^(?:[0-9a-fA-F]{2})*$/;
const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/;

/**
 * Returns lowercase hex of `length` bytes, or "" when absent or empty. JSON uses hex; protobuf
 * uses bytes.
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

/** Defaults to 0 when absent. */
export function uint64(from: object, key: string): bigint {
  const value = int64(from, key);
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new MalformedError(`${key} is not an unsigned 64-bit integer`);
  }
  return value;
}

/** Accepts protobuf bytes or JSON base64. IDs use hex instead. */
export function bytesOf(value: unknown, key: string): Buffer {
  if (value instanceof Uint8Array)
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === "string" && BASE64.test(value)) return Buffer.from(value, "base64");
  throw new MalformedError(`${key} is not base64`);
}
