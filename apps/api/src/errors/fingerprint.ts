import { createHash } from "node:crypto";

/**
 * Which errors are "the same error": occurrences with the same fingerprint
 * form one group in the Errors list (docs/errors.md, "Grouping").
 *
 * Version 1 groups by three things, each made stable across deploys:
 *
 * 1. The type, such as "TypeError".
 * 2. The message, with what changes between occurrences of one bug
 *    replaced: IDs, long numbers, URLs (normalizeMessage).
 * 3. The file of the stack's top frame, without its origin, query, or the
 *    content hash a bundler puts in its name (normalizeFile).
 *
 * Function names and line numbers are left out on purpose: in minified
 * code both change with every build, so each release would start new
 * groups. Two bugs with the same message in the same bundle therefore
 * share a group, until source maps (planned) give real names.
 *
 * The version is part of the fingerprint ("1-…"): a new rule gets a new
 * number, so old and new groups never mix.
 */
export const FINGERPRINT_VERSION = 1;

/** "1-" and 20 hex digits (80 bits of SHA-256): what the routes accept. */
export const FINGERPRINT_PATTERN = "^[0-9]{1,3}-[0-9a-f]{20}$";

/** The top frame's location, from V8 (Chrome, Edge, Node.js), Firefox, or Safari stack text. */
export interface StackFrame {
  function: string;
  file: string;
  line: number | null;
  column: number | null;
}

/** Longest stack line and file name read: a frame is far shorter, and the cap bounds the work. */
const MAX_LINE = 1000;
const MAX_FILE = 500;
const MAX_LINES = 200;

/** ":line:col" or ":line" at the end of a location. */
const LINE_AND_COLUMN = /:(\d{1,9})(?::(\d{1,9}))?$/;
/** A location that is a frame's: a URL, a path, or V8's "<anonymous>" and "native". */
const LOCATION = /^(?:[a-z][\w+.-]{0,30}:\/\/|\/|<anonymous>$|native$)/i;

function frameAt(name: string, location: string): StackFrame | null {
  const position = LINE_AND_COLUMN.exec(location);
  const file = position === null ? location : location.slice(0, position.index);
  if (file === "" || !LOCATION.test(file)) return null;
  return {
    function: name.trim(),
    file,
    line: position?.[1] === undefined ? null : Number(position[1]),
    column: position?.[2] === undefined ? null : Number(position[2]),
  };
}

/** V8: "at render (url:1:2)", "at url:1:2", "at async load (…)", "at new Widget (…)". */
function v8Frame(line: string): StackFrame | null {
  const rest = line.slice(3).trim();
  if (rest.endsWith(")")) {
    const open = rest.lastIndexOf(" (");
    if (open !== -1) {
      const name = rest.slice(0, open).replace(/^(?:async )?(?:new )?/, "");
      return frameAt(name, rest.slice(open + 2, -1));
    }
  }
  return frameAt("", rest);
}

/** Firefox and Safari: "render@url:1:2", "@url:1:2", "global code@url:1:2". */
function geckoFrame(line: string): StackFrame | null {
  const at = line.indexOf("@");
  return at === -1 ? null : frameAt(line.slice(0, at), line.slice(at + 1));
}

/**
 * The frames of a stack, top first. A stack with V8 frames ("at …") is read
 * as V8's only, so its first line, "Type: message", is never taken for a
 * frame, even with an "@" in the message. Lines that are not frames are
 * skipped. Plain string work on capped lines: a hostile stack costs as
 * little as a real one.
 */
export function parseStack(stack: string): StackFrame[] {
  const lines = stack
    .split(/\r\n|[\n\r\u2028\u2029]/, MAX_LINES)
    .map((line) => line.slice(0, MAX_LINE).trim())
    .filter((line) => line !== "");
  const v8 = lines.some((line) => line.startsWith("at "));
  const frames: StackFrame[] = [];
  for (const line of lines) {
    const frame = v8 ? (line.startsWith("at ") ? v8Frame(line) : null) : geckoFrame(line);
    if (frame !== null) frames.push(frame);
  }
  return frames;
}

/**
 * A content hash in a file name: "-", "." or "_" and six or more letters,
 * digits, or "_" with at least one digit, before the extension, as in
 * "index-BfK3x9A2.js" (Vite), "main.3f2a1c9d.js" (webpack), or
 * "page-1a2b3c4d5e6f.js" (Next.js).
 */
const CONTENT_HASH = /[-._](?=[A-Za-z_]*\d)[A-Za-z0-9_]{6,}(?=\.(?:m|c)?js$)/;

/** A frame's file, stable across deploys: path only, without a bundler's content hash. */
export function normalizeFile(file: string): string {
  let path = file.slice(0, MAX_LINE);
  try {
    const url = new URL(file);
    if (url.protocol === "http:" || url.protocol === "https:") path = url.pathname;
  } catch {
    // Not a URL: "<anonymous>", "native", a Node.js path.
  }
  const slash = path.lastIndexOf("/");
  // Capped first: the pattern below is quadratic in the worst case.
  const name = path.slice(slash + 1, slash + 1 + MAX_FILE).replace(CONTENT_HASH, "");
  return `${path.slice(0, slash + 1)}${name}`.slice(0, MAX_FILE);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s'"`)<>]+/gi;
// Eight or more hex digits with at least one digit: an ID or hash.
const HEX_ID = /\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi;
// Four or more digits: an ID, a count, a time. Shorter ones, such as an
// HTTP status, often tell failures apart, so they stay.
const LONG_NUMBER = /\d{4,}/g;

/** A message without the parts that differ between occurrences of one bug. */
export function normalizeMessage(message: string): string {
  return message
    .replace(UUID, "<id>")
    .replace(URL_IN_TEXT, "<url>")
    .replace(HEX_ID, "<id>")
    .replace(LONG_NUMBER, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

/** The group an occurrence belongs to: "1-" and 20 hex digits. */
export function fingerprint(error: { type: string; message: string; stack?: string }): string {
  const top = parseStack(error.stack ?? "")[0];
  const parts = [error.type, normalizeMessage(error.message), top ? normalizeFile(top.file) : ""];
  const hash = createHash("sha256").update(parts.join("\n"), "utf8").digest("hex").slice(0, 20);
  return `${FINGERPRINT_VERSION}-${hash}`;
}
