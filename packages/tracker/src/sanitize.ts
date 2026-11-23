/**
 * One invalid event makes the API reject the whole batch. Validate before queuing.
 */

export type PropertyValue = string | number | boolean | null;
export type Properties = Record<string, PropertyValue>;

const MAX_NAME_LENGTH = 200;
const MAX_KEYS = 30;
const MAX_KEY_LENGTH = 100;
const MAX_STRING_LENGTH = 500;
const MAX_PROPERTIES_BYTES = 8 * 1024;

const encoder = new TextEncoder();

export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/**
 * PostgreSQL can't store NUL or unpaired surrogates (jsonb rejects them). Older browsers lack
 * isWellFormed, and older Safari cannot parse lookbehind.
 */
export const UNSTORABLE =
  /\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * As the API checks a user ID: 1 to 200 characters (the u flag counts them
 * as the API does, not UTF-16 units), no control characters.
 */
// eslint-disable-next-line no-control-regex -- control characters are what it refuses
const USER_ID = /^[^\u0000-\u001F\u007F-\u009F]{1,200}$/u;

/** A site's user ID, trimmed, or undefined when the API would refuse it. */
export function cleanUserId(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const id = String(value).trim();
  return USER_ID.test(id) && !UNSTORABLE.test(id) ? id : undefined;
}

/** A user ID's signature as the API takes it: 64 hex digits, trimmed, or undefined. */
export function cleanSignature(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const signature = value.trim();
  return /^[0-9a-fA-F]{64}$/.test(signature) ? signature : undefined;
}

/** The first `max` UTF-16 units, without splitting a surrogate pair at the end. */
function cut(text: string, max: number): string {
  const head = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
}

/**
 * Turns a value into text without control characters (C0, DEL, C1; all but tabs and newlines when
 * `lines`) and unpaired surrogates, then cuts to `max` UTF-16 units. May
 * return "".
 */
export function cleanText(text: unknown, max: number, lines = false): string {
  let clean = "";
  // for…of visits whole code points: a lone surrogate arrives on its own.
  for (const character of String(text)) {
    const code = character.charCodeAt(0);
    if (
      character.length === 2 ||
      (lines && (code === 9 || code === 10)) ||
      (code > 31 && (code < 127 || code > 159) && (code < 0xd800 || code > 0xdfff))
    ) {
      clean += character;
      if (clean.length > max) break;
    }
  }
  return cut(clean, max);
}

/**
 * A custom event's name: no control characters or unpaired surrogates, 200
 * characters at most. May return "".
 */
export function sanitizeName(name: unknown): string {
  return cleanText(name, MAX_NAME_LENGTH);
}

/**
 * Keeps up to 30 flat values: strings (cut to 500 characters), finite
 * numbers, booleans, and null. Nested objects, arrays, functions, overlong
 * keys, and keys or strings PostgreSQL cannot store (see UNSTORABLE) are
 * dropped. Returns undefined when nothing is left.
 */
export function sanitizeProperties(input: unknown): Properties | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const properties: Properties = {};
  let count = 0;
  for (const [key, value] of Object.entries(input)) {
    if (count === MAX_KEYS) break;
    if (key.length === 0 || key.length > MAX_KEY_LENGTH || UNSTORABLE.test(key)) continue;
    if (typeof value === "string") {
      if (UNSTORABLE.test(value)) continue;
      properties[key] = cut(value, MAX_STRING_LENGTH);
    } else if (
      (typeof value === "number" && Number.isFinite(value)) ||
      typeof value === "boolean" ||
      value === null
    ) {
      properties[key] = value;
    } else {
      continue;
    }
    count += 1;
  }
  // Stay under the API's 8 KB limit by dropping the last keys if needed.
  const keys = Object.keys(properties);
  while (byteLength(JSON.stringify(properties)) > MAX_PROPERTIES_BYTES) {
    const last = keys.pop();
    if (last === undefined) break;
    delete properties[last];
  }
  return keys.length > 0 ? properties : undefined;
}
