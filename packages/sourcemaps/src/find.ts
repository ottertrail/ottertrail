import { lstat, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const MAP_FILE = /\.[cm]?js\.map$/u;
/** As the server checks a path: a leading slash, at most 2048 characters, no whitespace or control characters. */
// eslint-disable-next-line no-control-regex -- control characters are what it refuses
const SERVER_PATH = /^\/[^?#\s\u0000-\u001F\u007F]{0,2047}$/u;

export interface SourceMapFile {
  /** Absolute path of the .map file. */
  mapPath: string;
  /** The map's path inside the build directory, with forward slashes, for messages. */
  relativeMap: string;
  /** The minified file's URL path, as a browser's stack frame gives it. */
  urlPath: string;
  bytes: number;
}

export interface FoundMaps {
  maps: SourceMapFile[];
  warnings: string[];
}

/**
 * A file name as it appears in a URL path. The URL parser encodes spaces
 * and non-ASCII characters itself, as a browser does; these four it would
 * read as URL syntax instead.
 */
function encodeSegment(segment: string): string {
  return segment.replace(/[%?#\\]/gu, (character) => encodeURIComponent(character));
}

/**
 * The URL path a browser reports for a file at `relativeFile` (a path inside
 * the build directory, with the platform's separators) when the directory
 * is served at `urlPrefix` ("/" or "/static/"): `new URL(frameUrl).pathname`.
 */
export function urlPathFor(urlPrefix: string, relativeFile: string): string {
  const segments = relativeFile.split(sep).map((segment) => encodeSegment(segment));
  return new URL(urlPrefix + segments.join("/"), "http://placeholder").pathname;
}

async function* walk(directory: string): AsyncGenerator<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    // Symbolic links are never followed: they could lead out of the build
    // directory, and --delete-after-upload must only touch files in it.
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile() && MAP_FILE.test(entry.name)) yield path;
  }
}

/** Every source map under `directory` whose minified file lies next to it. */
export async function findSourceMaps(directory: string, urlPrefix: string): Promise<FoundMaps> {
  const maps: SourceMapFile[] = [];
  const warnings: string[] = [];
  for await (const mapPath of walk(directory)) {
    const relativeMap = relative(directory, mapPath).split(sep).join("/");
    const minifiedPath = mapPath.slice(0, -".map".length);
    const minified = await stat(minifiedPath).catch(() => null);
    if (minified === null || !minified.isFile()) {
      warnings.push(
        `Skipped ${relativeMap}: ${relativeMap.slice(0, -".map".length)} is not next to it.`,
      );
      continue;
    }
    const urlPath = urlPathFor(urlPrefix, relative(directory, minifiedPath));
    if (!SERVER_PATH.test(urlPath)) {
      warnings.push(`Skipped ${relativeMap}: its URL path is longer than 2048 characters.`);
      continue;
    }
    const { size } = await lstat(mapPath);
    maps.push({ mapPath, relativeMap, urlPath, bytes: size });
  }
  return { maps, warnings };
}
