import { createHash } from "node:crypto";

/**
 * Fingerprint grouping (docs/errors.md, "Grouping") uses error type,
 * normalized message, and the top frame file or JVM class. Omit function
 * names and line numbers because minification changes them across builds;
 * bugs with the same message in one bundle can share a group.
 * Version rule changes so fingerprints from different rules never mix.
 */
export const FINGERPRINT_VERSION = 1;

/** "1-" and 20 hex digits (80 bits of SHA-256): what the routes accept. */
export const FINGERPRINT_PATTERN = "^[0-9]{1,3}-[0-9a-f]{20}$";

export interface StackFrame {
  function: string;
  /** The file; for a JVM frame, the class. */
  file: string;
  line: number | null;
  column: number | null;
}

/** Cap stack lines and file names to bound parsing work. */
const MAX_LINE = 1000;
const MAX_FILE = 500;
const MAX_LINES = 200;

const LINE_AND_COLUMN = /:(\d{1,9})(?::(\d{1,9}))?$/;
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
 * Parse top-first frames. If V8 frames exist, use only V8 syntax so
 * "Type: message" containing "@" cannot become a frame. Cap line lengths
 * to bound work on hostile stacks.
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

function stackLines(stack: string): string[] {
  return stack
    .split(/\r\n|[\n\r\u2028\u2029]/)
    .map((line) => line.slice(0, MAX_LINE).trim())
    .filter((line) => line !== "");
}

function fileAndLine(location: string): { file: string; line: number } | null {
  const position = /:(\d{1,9})$/.exec(location);
  if (position === null || position.index === 0) return null;
  return { file: location.slice(0, position.index), line: Number(position[1]) };
}

/** Python: `File "/app/shop/cart.py", line 17, in total`. */
function pythonFrame(line: string): StackFrame | null {
  if (!line.startsWith('File "')) return null;
  const close = line.indexOf('", line ', 6);
  if (close === -1) return null;
  const rest = line.slice(close + 8);
  const digits = /^\d{1,9}/.exec(rest);
  if (digits === null) return null;
  const after = rest.slice(digits[0].length);
  return {
    function: after.startsWith(", in ") ? after.slice(5) : "",
    file: line.slice(6, close),
    line: Number(digits[0]),
    column: null,
  };
}

/** Ruby: "/app/models/cart.rb:17:in `total'", "from …", or Ruby 3.4's "in 'Cart#total'". */
function rubyFrame(line: string): StackFrame | null {
  const text = line.startsWith("from ") ? line.slice(5) : line;
  const at = text.indexOf(":in ");
  if (at === -1) return null;
  const quote = text[at + 4];
  if (quote !== "`" && quote !== "'") return null;
  const location = fileAndLine(text.slice(0, at));
  if (location === null) return null;
  if (!location.file.endsWith(".rb") && !location.file.startsWith("<")) return null;
  const close = text.indexOf("'", at + 5);
  return {
    function: close === -1 ? "" : text.slice(at + 5, close),
    file: location.file,
    line: location.line,
    column: null,
  };
}

/** Go: a function line, then its "/home/dev/shop/cart.go:17 +0x1d" line. */
function goLocation(line: string): { file: string; line: number } | null {
  const offset = line.lastIndexOf(" +0x");
  const location = fileAndLine(offset === -1 ? line : line.slice(0, offset));
  return location !== null && location.file.endsWith(".go") ? location : null;
}

/** Skip Go runtime and OpenTelemetry frames above the error site. */
function isGoPlumbing(frame: StackFrame): boolean {
  return (
    frame.function.startsWith("panic(") ||
    frame.function.startsWith("runtime.") ||
    frame.function.startsWith("runtime/") ||
    frame.function.startsWith("go.opentelemetry.io/")
  );
}

/** Java and other JVM languages: "at com.example.shop.CartService.checkout(CartService.java:88)". */
const JVM_SOURCE =
  /^(?:[\w$.-]+\.(?:java|kt|kts|scala|groovy|clj)(?::\d{1,9})?|Unknown Source|Native Method)$/;

/**
 * Strip Logback/Log4j jar suffixes with string operations; regex matching
 * backtracks on long runs of spaces.
 */
function withoutJar(rest: string): string {
  if (!rest.endsWith("]")) return rest;
  const open = rest.lastIndexOf("[");
  if (open === -1 || rest.indexOf("]", open) !== rest.length - 1) return rest;
  const end = rest[open - 1] === "~" ? open - 1 : open;
  const frame = rest.slice(0, end).trimEnd();
  // The jar follows the frame after a space; a "[" inside the frame is part of it.
  return frame.length < end ? frame : rest;
}

function jvmFrame(line: string): StackFrame | null {
  if (!line.startsWith("at ")) return null;
  const rest = withoutJar(line.slice(3)).trim();
  const open = rest.indexOf("(");
  if (open <= 0 || !rest.endsWith(")")) return null;
  const source = rest.slice(open + 1, -1);
  if (!JVM_SOURCE.test(source)) return null;
  const qualified = rest.slice(rest.lastIndexOf("/", open) + 1, open);
  const dot = qualified.lastIndexOf(".");
  if (dot <= 0 || /\s/.test(qualified)) return null;
  const position = /:(\d{1,9})$/.exec(source);
  return {
    function: qualified.slice(dot + 1),
    // Use the qualified class because file names repeat across packages.
    file: qualified.slice(0, dot),
    line: position === null ? null : Number(position[1]),
    column: null,
  };
}

/** .NET: "at Shop.Services.CartService.Checkout(Int32 cartId) in /src/Shop/CartService.cs:line 88". */
function dotnetFrame(line: string): StackFrame | null {
  if (!line.startsWith("at ")) return null;
  let rest = line.slice(3);
  let file = "";
  let lineNumber: number | null = null;
  const inFile = rest.lastIndexOf(" in ");
  if (inFile !== -1 && !rest.endsWith(")")) {
    const location = rest.slice(inFile + 4);
    const marker = location.lastIndexOf(":line ");
    if (marker === -1 || !/^\d{1,9}$/.test(location.slice(marker + 6))) return null;
    file = location.slice(0, marker);
    lineNumber = Number(location.slice(marker + 6));
    rest = rest.slice(0, inFile);
  }
  const open = rest.indexOf("(");
  if (open <= 0 || !rest.endsWith(")")) return null;
  const method = rest.slice(0, open);
  if (/\s/.test(method)) return null;
  const dot = method.lastIndexOf(".");
  return {
    function: dot === -1 ? method : method.slice(dot + 1),
    file: file !== "" ? file : dot === -1 ? method : method.slice(0, dot),
    line: lineNumber,
    column: null,
  };
}

/**
 * Return the error-site frame first: reverse Python tracebacks and skip
 * Go runtime/OpenTelemetry frames. Use the first format with frames.
 * Cap lines as in parseStack; read Python from the end.
 */
export function parseServerStack(stack: string): StackFrame[] {
  const all = stackLines(stack);
  const python = all
    .slice(-MAX_LINES)
    .map(pythonFrame)
    .filter((frame) => frame !== null);
  if (python.length > 0) return python.toReversed();

  const lines = all.slice(0, MAX_LINES);
  const ruby = lines.map(rubyFrame).filter((frame) => frame !== null);
  if (ruby.length > 0) return ruby;

  const go: StackFrame[] = [];
  for (const [index, line] of lines.entries()) {
    const location = goLocation(line);
    if (location === null) continue;
    const name = index === 0 ? "" : (lines[index - 1] ?? "");
    go.push({
      function: goLocation(name) === null ? name : "",
      file: location.file,
      line: location.line,
      column: null,
    });
  }
  if (go.length > 0) {
    const raised = go.findIndex((frame) => !isGoPlumbing(frame));
    return raised === -1 ? go : go.slice(raised);
  }

  const jvm = lines.map(jvmFrame).filter((frame) => frame !== null);
  if (jvm.length > 0) return jvm;
  return lines.map(dotnetFrame).filter((frame) => frame !== null);
}

/**
 * Bundler hash suffixes: -, ., or _ followed by at least six letters,
 * digits, or underscores, including a digit (Vite, webpack, Next.js).
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
const HEX_ID = /\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi;
// Keep numbers shorter than four digits, such as HTTP status codes,
// because they can distinguish failures.
const LONG_NUMBER = /\d{4,}/g;

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

/**
 * Try server formats first for server errors: Firefox syntax can mistake
 * Python messages containing URLs with "@" for frames. Node.js falls
 * back to V8 syntax. Fingerprints use "1-" plus 20 hex digits.
 */
export function fingerprint(
  error: { type: string; message: string; stack?: string },
  { server = false }: { server?: boolean } = {},
): string {
  const stack = error.stack ?? "";
  const top = server
    ? (parseServerStack(stack)[0] ?? parseStack(stack)[0])
    : (parseStack(stack)[0] ?? parseServerStack(stack)[0]);
  const parts = [error.type, normalizeMessage(error.message), top ? normalizeFile(top.file) : ""];
  const hash = createHash("sha256").update(parts.join("\n"), "utf8").digest("hex").slice(0, 20);
  return `${FINGERPRINT_VERSION}-${hash}`;
}
