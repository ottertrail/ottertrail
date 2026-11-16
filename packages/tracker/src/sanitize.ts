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

/** Removes control characters and caps the length. May return "". */
export function sanitizeName(name: unknown): string {
  let clean = "";
  for (const character of String(name)) {
    const code = character.charCodeAt(0);
    if (code > 31 && code !== 127) {
      clean += character;
    }
  }
  return clean.slice(0, MAX_NAME_LENGTH);
}

/**
 * Keeps up to 30 flat values: strings (cut to 500 characters), finite
 * numbers, booleans, and null. Nested objects, arrays, functions, and
 * overlong keys are dropped. Returns undefined when nothing is left.
 */
export function sanitizeProperties(input: unknown): Properties | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const properties: Properties = {};
  let count = 0;
  for (const [key, value] of Object.entries(input)) {
    if (count === MAX_KEYS) break;
    if (key.length === 0 || key.length > MAX_KEY_LENGTH) continue;
    if (typeof value === "string") {
      properties[key] = value.slice(0, MAX_STRING_LENGTH);
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
