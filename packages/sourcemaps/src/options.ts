import { statSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

/** Read the secret from the environment to keep it out of shell history and CI logs. */
export const SECRET_KEY_VARIABLE = "OTTERTRAIL_SECRET_KEY";

const SECRET_KEY = /^sk_[0-9a-f]{32}$/;
/** As the server checks it: 1 to 200 characters, no whitespace or control characters. */
// eslint-disable-next-line no-control-regex -- control characters are what it refuses
const RELEASE = /^[^\s\u0000-\u001F\u007F-\u009F]{1,200}$/u;
// eslint-disable-next-line no-control-regex -- control characters are what it refuses
const RELEASE_REFUSED = /[\s\u0000-\u001F\u007F-\u009F]/u;
// eslint-disable-next-line no-control-regex -- control characters are what it refuses
const PREFIX_REFUSED = /[?#\s\u0000-\u001F\u007F]/u;
/** Limit parallel uploads to reduce server waits. */
const MAX_CONCURRENCY = 8;

export const USAGE = `Usage: ottertrail-sourcemaps upload <directory> --release <release> --host <url> [options]

Uploads every *.js.map, *.mjs.map, and *.cjs.map file under <directory> to
Ottertrail, for one release. The project's secret key (sk_...) is read from
the ${SECRET_KEY_VARIABLE} environment variable.

Options:
  --release <release>     The release, the same as the tracker's data-release.
  --host <url>            The Ottertrail address, such as https://analytics.example.com.
  --url-prefix <path>     Where <directory> is served on the site (default: /).
                          Example: --url-prefix /static/ when dist/app.js is
                          loaded from /static/app.js.
  --concurrency <n>       Uploads at the same time, 1 to ${MAX_CONCURRENCY} (default: 2). The
                          server stores 2 of a project's maps at once; it asks
                          more to wait and send again.
  --dry-run               List what would be uploaded, and send nothing.
  --delete-after-upload   Delete each .map file once its upload succeeded.
  -h, --help              Show this help.`;

export interface UploadOptions {
  /** Absolute path of the build directory. */
  directory: string;
  release: string;
  /** The Ottertrail origin, such as https://analytics.example.com. */
  origin: string;
  /** A URL path that starts and ends with "/". */
  urlPrefix: string;
  concurrency: number;
  dryRun: boolean;
  deleteAfterUpload: boolean;
  /** Null only for a dry run without a key. */
  secretKey: string | null;
  /** True when the key would travel over plain http to another computer. */
  insecureHost: boolean;
}

export type ParsedCommand =
  | { kind: "help" }
  | { kind: "upload"; options: UploadOptions }
  | { kind: "error"; message: string };

const error = (message: string): ParsedCommand => ({ kind: "error", message });

/**
 * "/", "/static/", "/a/b/": the URL path the build directory is served
 * from, normalized to start and end with one slash. A full URL (a CDN, say)
 * gives its path, since stack frames are matched by path only. Null when
 * the prefix cannot be a URL path.
 */
export function normalizeUrlPrefix(raw: string): string | null {
  let prefix = raw.trim();
  if (/^https?:\/\//iu.test(prefix)) {
    let url: URL;
    try {
      url = new URL(prefix);
    } catch {
      return null;
    }
    if (url.search !== "" || url.hash !== "") return null;
    prefix = url.pathname;
  }
  if (PREFIX_REFUSED.test(prefix) || prefix.includes("\\")) return null;
  const trimmed = prefix.replace(/^\/+/u, "").replace(/\/+$/u, "");
  return trimmed === "" ? "/" : `/${trimmed}/`;
}

/** The problem with a release, or null when the server accepts it. */
export function releaseProblem(release: string): string | null {
  if (RELEASE.test(release) && release.isWellFormed()) return null;
  if (release === "") return "--release is empty.";
  if (RELEASE_REFUSED.test(release) || !release.isWellFormed()) {
    return "--release may not contain spaces, tabs, line breaks, or other control characters.";
  }
  return "--release is too long: at most 200 characters are allowed.";
}

function parseHost(raw: string): { origin: string; insecure: boolean } | string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `--host is not a URL: give the Ottertrail address, such as https://analytics.example.com.`;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "--host must start with https:// (or http:// for a local install).";
  }
  if (url.username !== "" || url.password !== "") {
    return "--host may not contain a user name or password.";
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || /[?#]/u.test(raw)) {
    return "--host is the Ottertrail address only, without a path, query, or fragment, such as https://analytics.example.com.";
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return { origin: url.origin, insecure: url.protocol === "http:" && !local };
}

/** Validate arguments and environment before reading files or sending requests. */
export function parseCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ParsedCommand {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        release: { type: "string" },
        host: { type: "string" },
        "url-prefix": { type: "string" },
        concurrency: { type: "string" },
        "dry-run": { type: "boolean" },
        "delete-after-upload": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (cause) {
    const keyFlag = argv.some((arg) => /^--?(?:secret-?)?key(?:=|$)|^--token(?:=|$)/iu.test(arg));
    if (keyFlag) {
      return error(
        `The secret key is read from the ${SECRET_KEY_VARIABLE} environment variable only, never from a flag. Remove it from the command, and consider the key exposed if this ran in a shared log.`,
      );
    }
    return error(cause instanceof Error ? cause.message : String(cause));
  }
  const { values, positionals } = parsed;
  if (values.help === true) return { kind: "help" };

  const [command, directoryArgument, ...extra] = positionals;
  if (command === undefined)
    return error("Missing the command: ottertrail-sourcemaps upload <directory> ...");
  if (command !== "upload") return error(`Unknown command "${command}": the command is upload.`);
  if (directoryArgument === undefined)
    return error("Missing the build directory: upload <directory>.");
  if (extra.length > 0)
    return error("upload takes one directory. Quote a path that contains spaces.");

  const dryRun = values["dry-run"] === true;
  const deleteAfterUpload = values["delete-after-upload"] === true;
  if (dryRun && deleteAfterUpload) {
    return error(
      "--dry-run and --delete-after-upload cannot be used together: a dry run changes nothing.",
    );
  }

  if (values.release === undefined)
    return error("Missing --release: the same release as the tracker's data-release.");
  const release = values.release;
  const badRelease = releaseProblem(release);
  if (badRelease !== null) return error(badRelease);

  if (values.host === undefined)
    return error("Missing --host: the Ottertrail address, such as https://analytics.example.com.");
  const host = parseHost(values.host);
  if (typeof host === "string") return error(host);

  const urlPrefix = normalizeUrlPrefix(values["url-prefix"] ?? "/");
  if (urlPrefix === null) {
    return error(
      "--url-prefix must be a URL path such as /static/, without a query, fragment, or spaces.",
    );
  }

  // The server's own limit for one project (apps/api/src/source-maps/routes.ts).
  let concurrency = 2;
  if (values.concurrency !== undefined) {
    concurrency = /^\d+$/u.test(values.concurrency) ? Number(values.concurrency) : Number.NaN;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
      return error(`--concurrency must be a whole number from 1 to ${MAX_CONCURRENCY}.`);
    }
  }

  // CI secrets may include a trailing line break.
  const rawKey = env[SECRET_KEY_VARIABLE]?.trim() ?? "";
  let secretKey: string | null = null;
  if (rawKey === "") {
    if (!dryRun) {
      return error(
        `Missing the secret key: set ${SECRET_KEY_VARIABLE} to the project's secret key (sk_ and 32 hexadecimal characters).`,
      );
    }
  } else if (!SECRET_KEY.test(rawKey)) {
    return error(
      `${SECRET_KEY_VARIABLE} is not a secret key: one is sk_ followed by 32 lower-case hexadecimal characters. A public key cannot upload source maps.`,
    );
  } else {
    secretKey = rawKey;
  }

  const directory = resolve(directoryArgument);
  let isDirectory = false;
  try {
    isDirectory = statSync(directory).isDirectory();
  } catch {
    return error(`The directory ${directory} does not exist.`);
  }
  if (!isDirectory) return error(`${directory} is not a directory.`);

  return {
    kind: "upload",
    options: {
      directory,
      release,
      origin: host.origin,
      urlPrefix,
      concurrency,
      dryRun,
      deleteAfterUpload,
      secretKey,
      insecureHost: host.insecure,
    },
  };
}
