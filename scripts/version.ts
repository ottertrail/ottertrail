/**
 * Sets the release version everywhere it is written, together: the root
 * package.json, apps/api/package.json (the API reports it, and webhooks
 * name it), and the image tag deploy/compose.yaml runs by default. Runs
 * with plain Node.js, without dependencies.
 *
 *   vp run version <x.y.z>                     sets it
 *   node scripts/version.ts --check <x.y.z>    fails unless all three are it
 *
 * The release workflow runs the check against each tag. Releasing is in
 * docs/deployment.md, "Releasing".
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Semantic Versioning 2.0.0's own pattern (https://semver.org), without a
// leading "v".
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function isSemver(version: string): boolean {
  return SEMVER.test(version);
}

/**
 * Why version cannot be a release, or null when it can. It must be a
 * semantic version, without build metadata (1.0.0+b1): the image is tagged
 * with the version, and a Docker tag cannot hold a "+".
 */
export function versionProblem(version: string): string | null {
  if (!isSemver(version)) return `Not a semantic version (x.y.z, without a "v"): ${version}`;
  if (version.includes("+")) {
    return `Build metadata ("+…") is not allowed in a release version. Docker tags cannot contain "+": ${version}`;
  }
  return null;
}

interface Place {
  /** From the repository root. */
  file: string;
  /** Matches the version in its first group, with what is around it. */
  pattern: RegExp;
}

// The first "version" key of a package.json, at the top level's indentation.
const PACKAGE_VERSION = /^( {2}"version": ")([^"]*)(",?)$/m;

export const PLACES: Place[] = [
  { file: "package.json", pattern: PACKAGE_VERSION },
  { file: "apps/api/package.json", pattern: PACKAGE_VERSION },
  {
    file: "deploy/compose.yaml",
    pattern: /(image: ghcr\.io\/ottertrail\/ottertrail:\$\{OTTERTRAIL_VERSION:-)([^}]*)(\})/,
  },
];

function find(text: string, place: Place): RegExpExecArray {
  const match = place.pattern.exec(text);
  if (match === null) throw new Error(`No version found in ${place.file}`);
  return match;
}

/** The version each place holds now. */
export function readVersions(root: string): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const place of PLACES) {
    versions[place.file] = find(readFileSync(join(root, place.file), "utf8"), place)[2] ?? "";
  }
  return versions;
}

/**
 * Writes version into every place, or into none: it reads all of them and
 * writes each new text to a temporary file first, then renames them into
 * place.
 */
export function setVersion(root: string, version: string): void {
  const problem = versionProblem(version);
  if (problem !== null) throw new Error(problem);
  const updated = PLACES.map((place) => {
    const path = join(root, place.file);
    const text = readFileSync(path, "utf8");
    find(text, place);
    return {
      path,
      text: text.replace(place.pattern, (_all, before: string, _old: string, after: string) => {
        return `${before}${version}${after}`;
      }),
    };
  });
  const temporary = updated.map(({ path }) => `${path}.version-${process.pid}.tmp`);
  try {
    updated.forEach(({ text }, index) => writeFileSync(temporary[index] ?? "", text));
  } catch (error) {
    for (const path of temporary) rmSync(path, { force: true });
    throw error;
  }
  updated.forEach(({ path }, index) => renameSync(temporary[index] ?? "", path));
}

/** The places that do not hold version, as messages; empty when all do. */
export function checkVersion(root: string, version: string): string[] {
  const problem = versionProblem(version);
  if (problem !== null) return [problem];
  return Object.entries(readVersions(root))
    .filter(([, found]) => found !== version)
    .map(([file, found]) => `${file} has ${found}, not ${version}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = join(import.meta.dirname, "..");
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  try {
    if (args[0] === "--check" && args.length === 2) {
      const problems = checkVersion(root, args[1] ?? "");
      for (const problem of problems) console.error(problem);
      process.exit(problems.length === 0 ? 0 : 1);
    }
    if (args.length !== 1 || args[0]?.startsWith("-")) {
      console.error("Usage: vp run version <x.y.z>, or node scripts/version.ts --check <x.y.z>");
      process.exit(1);
    }
    const version = args[0] ?? "";
    setVersion(root, version);
    for (const file of PLACES.map((place) => place.file)) console.log(`${file}: ${version}`);
    console.log(
      `Next: commit "chore(release): ${version}". Create tag v${version}. Push the tag (docs/deployment.md, "Releasing").`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
