import { unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { findSourceMaps, type SourceMapFile } from "./find.ts";
import { parseCommand, SECRET_KEY_VARIABLE, USAGE } from "./options.ts";
import { type UploadOutcome, uploadSourceMap } from "./upload.ts";

export interface RunEnvironment {
  env: Readonly<Record<string, string | undefined>>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

/** Exit codes: 0 all uploaded, 1 an upload (or a deletion) failed, 2 the command was wrong. */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
export async function run(argv: readonly string[], io: RunEnvironment): Promise<number> {
  // Redact secrets from all output, including errors.
  const rawKey = io.env[SECRET_KEY_VARIABLE]?.trim() ?? "";
  const redact = (line: string) => {
    let text = line.replace(/\bsk_[0-9a-z]{8,}/giu, "sk_[redacted]");
    if (rawKey.length >= 8) text = text.split(rawKey).join("[redacted]");
    return text;
  };
  const out = (line: string) => io.stdout(redact(line));
  const err = (line: string) => io.stderr(redact(line));

  const command = parseCommand(argv, io.env);
  if (command.kind === "help") {
    out(USAGE);
    return EXIT_OK;
  }
  if (command.kind === "error") {
    err(`Error: ${command.message}`);
    err("Run ottertrail-sourcemaps --help for the options.");
    return EXIT_USAGE;
  }
  const options = command.options;

  let found;
  try {
    found = await findSourceMaps(options.directory, options.urlPrefix);
  } catch (error) {
    err(
      `Error: could not read ${options.directory}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return EXIT_FAILED;
  }
  for (const warning of found.warnings) err(`Warning: ${warning}`);
  const { maps } = found;
  if (maps.length === 0) {
    err(
      `Error: no source maps (*.js.map, *.mjs.map, *.cjs.map) with their minified file next to them in ${options.directory}. Is the build set to write source maps?`,
    );
    return EXIT_FAILED;
  }

  const width = Math.max(...maps.map((map) => map.urlPath.length));
  const line = (label: string, map: SourceMapFile, detail = "") =>
    `${label.padEnd(9)} ${map.urlPath.padEnd(width)}  ${map.relativeMap}${detail}`;

  if (options.dryRun) {
    out(`Dry run: nothing is sent. Release ${options.release}, to ${options.origin}:`);
    for (const map of maps) out(line("would send", map, ` (${sizeText(map.bytes)})`));
    out(`${plural(maps.length, "source map")} would be uploaded.`);
    return EXIT_OK;
  }

  // parseCommand allows no key only for a dry run.
  const secretKey = options.secretKey ?? "";
  if (options.insecureHost) {
    err("Warning: --host uses http://, so the secret key travels unencrypted. Use https://.");
  }
  out(
    `Uploading ${plural(maps.length, "source map")} for release ${options.release} to ${options.origin}`,
  );

  const context = {
    endpoint: new URL("/api/source-maps", options.origin),
    release: options.release,
    secretKey,
    fetch: io.fetch ?? globalThis.fetch,
    sleep: io.sleep ?? ((milliseconds: number) => delay(milliseconds)),
  };
  const counts = { stored: 0, replaced: 0, failed: 0, notSent: 0, deleted: 0, deleteFailed: 0 };
  let stopped: string | null = null;
  let next = 0;

  const finish = async (map: SourceMapFile, outcome: UploadOutcome) => {
    if (outcome.status === "failed") {
      counts.failed++;
      err(line("failed", map, `: ${outcome.message}`));
      return;
    }
    counts[outcome.status]++;
    if (!options.deleteAfterUpload) {
      out(line(outcome.status, map));
      return;
    }
    // Only the map just uploaded, found as a regular file ending in .map.
    if (!map.mapPath.endsWith(".map")) throw new Error(`refusing to delete ${map.mapPath}`);
    try {
      await unlink(map.mapPath);
      counts.deleted++;
      out(line(outcome.status, map, " (deleted)"));
    } catch (error) {
      counts.deleteFailed++;
      err(
        line(
          outcome.status,
          map,
          `, but it could not be deleted: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  };

  const worker = async () => {
    while (stopped === null && next < maps.length) {
      const map = maps[next++];
      if (map === undefined) break;
      let outcome: UploadOutcome;
      try {
        outcome = await uploadSourceMap(map, context);
      } catch (error) {
        outcome = {
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
          fatal: false,
        };
      }
      await finish(map, outcome);
      if (outcome.status === "failed" && outcome.fatal) stopped ??= outcome.message;
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, maps.length) }, worker));

  counts.notSent = maps.length - counts.stored - counts.replaced - counts.failed;
  if (stopped !== null && counts.notSent > 0) {
    err(
      `Stopped: the other uploads would fail the same way, so ${plural(counts.notSent, "map")} were not sent.`,
    );
  }
  const parts = [
    `${counts.stored} stored`,
    `${counts.replaced} replaced`,
    `${counts.failed} failed`,
  ];
  if (counts.notSent > 0) parts.push(`${counts.notSent} not sent`);
  if (found.warnings.length > 0) parts.push(`${found.warnings.length} skipped`);
  if (options.deleteAfterUpload) {
    parts.push(`${counts.deleted} deleted`);
    if (counts.deleteFailed > 0) parts.push(`${counts.deleteFailed} could not be deleted`);
  }
  const summary = `Release ${options.release}: ${parts.join(", ")}.`;
  const ok = counts.failed === 0 && counts.notSent === 0 && counts.deleteFailed === 0;
  if (ok) out(summary);
  else err(summary);
  return ok ? EXIT_OK : EXIT_FAILED;
}
