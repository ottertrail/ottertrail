/**
 * Makes custom event names and properties fit the API's rules before they
 * are queued. The API rejects a whole batch if one event breaks a rule, so
 * one bad `track()` call must not cost the page views sent with it.
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
 * Matches text PostgreSQL cannot store, which the API rejects: a NUL
 * character, or half of a UTF-16 surrogate pair without the other half. A
 * regular expression rather than String.prototype.isWellFormed, which older
 * browsers lack; no lookbehind, which older Safari cannot parse.
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

/** The first `max` UTF-16 units, without splitting a surrogate pair at the end. */
function cut(text: string, max: number): string {
  const head = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
}

/** Removes control characters and unpaired surrogates, and caps the length. May return "". */
export function sanitizeName(name: unknown): string {
  let clean = "";
  // for…of visits whole code points: a lone surrogate arrives on its own.
  for (const character of String(name)) {
    const code = character.charCodeAt(0);
    if (code > 31 && code !== 127 && !UNSTORABLE.test(character)) {
      clean += character;
    }
  }
  return cut(clean, MAX_NAME_LENGTH);
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
