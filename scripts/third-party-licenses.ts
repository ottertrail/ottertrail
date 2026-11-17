/**
 * A build plugin (Vite and `vp pack`) that writes THIRD_PARTY_LICENSES.txt
 * next to the build: every npm package whose files went into the bundle,
 * with the licence text it ships. Bundling copies their code without their
 * LICENSE files, and most licences (MIT, BSD, Apache) require that text to
 * travel with every copy.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const LICENSES_FILE_NAME = "THIRD_PARTY_LICENSES.txt";

export interface BundledPackage {
  name: string;
  version: string;
  /** What package.json declares, such as "MIT" or "(MIT OR Apache-2.0)". */
  license: string;
  /**
   * The package's licence file; failing that, the licence section of its
   * README; null when it ships neither.
   */
  text: string | null;
}

const NODE_MODULES = "/node_modules/";

/** LICENSE, LICENSE.md, LICENCE-MIT, COPYING.txt, and similar. */
const LICENSE_FILE = /^(licen[cs]e|copying)([.-][\w.-]*)?$/i;
const README_FILE = /^readme(\.md|\.markdown|\.txt)?$/i;
const LICENSE_HEADING = /^(#{1,6})\s+(the\s+)?licen[cs]e\b/i;

/** An absolute path as bundlers write module IDs: "/…", or "C:/…" on Windows. */
const ABSOLUTE_PATH = /^(\/|[A-Za-z]:\/)/;

/**
 * The directory of the npm package a bundled file comes from, or null for
 * the app's own files and virtual modules. Bundler module IDs use forward
 * slashes on every system. With pnpm a file sits at
 * …/node_modules/.pnpm/name@1.0.0/node_modules/name/lib/file.js: the last
 * node_modules segment names its package.
 */
export function packageDirectory(moduleId: string): string | null {
  const path = moduleId.split("?", 1)[0] ?? "";
  if (!ABSOLUTE_PATH.test(path)) {
    return null;
  }
  const at = path.lastIndexOf(NODE_MODULES);
  if (at === -1) {
    return null;
  }
  const parts = path.slice(at + NODE_MODULES.length).split("/");
  const nameParts = parts[0]?.startsWith("@") ? 2 : 1;
  if (parts.length <= nameParts) {
    return null;
  }
  return path.slice(0, at + NODE_MODULES.length) + parts.slice(0, nameParts).join("/");
}

function declaredLicense(manifest: object): string {
  const license = "license" in manifest ? manifest.license : undefined;
  const licenses = "licenses" in manifest ? manifest.licenses : undefined;
  if (typeof license === "string") {
    return license;
  }
  // Older packages: { type } or [{ type }].
  const entries = [license, ...(Array.isArray(licenses) ? licenses : [])];
  const types = entries.flatMap((entry) =>
    typeof entry === "object" && entry !== null && "type" in entry && typeof entry.type === "string"
      ? [entry.type]
      : [],
  );
  return types.length > 0 ? types.join(" OR ") : "not declared";
}

/** The README's licence section, from its heading to the next heading as high. */
export function readmeLicenseSection(readme: string): string | null {
  const lines = readme.split(/\r?\n/);
  const start = lines.findIndex((line) => LICENSE_HEADING.test(line));
  if (start === -1) {
    return null;
  }
  const level = LICENSE_HEADING.exec(lines[start] ?? "")?.[1]?.length ?? 1;
  const end = lines.findIndex((line, index) => {
    const heading = /^(#{1,6})\s/.exec(line);
    return index > start && heading !== null && (heading[1]?.length ?? 0) <= level;
  });
  const section = lines
    .slice(start, end === -1 ? undefined : end)
    .join("\n")
    .trim();
  return section.split("\n").length > 1 ? section : null;
}

/** Reads a package's name, version, declared licence, and licence text. */
export function readPackage(directory: string): BundledPackage {
  const parsed: unknown = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const manifest = typeof parsed === "object" && parsed !== null ? parsed : {};
  const name = "name" in manifest ? manifest.name : undefined;
  const version = "version" in manifest ? manifest.version : undefined;
  const files = readdirSync(directory)
    .filter((file) => LICENSE_FILE.test(file))
    .toSorted();
  const texts = files.map((file) => readFileSync(join(directory, file), "utf8").trim());
  return {
    name: typeof name === "string" ? name : directory,
    version: typeof version === "string" ? version : "unknown",
    license: declaredLicense(manifest),
    text: texts.length > 0 ? texts.join("\n\n") : readmeLicense(directory),
  };
}

function readmeLicense(directory: string): string | null {
  const readme = readdirSync(directory).find((file) => README_FILE.test(file));
  const section =
    readme === undefined
      ? null
      : readmeLicenseSection(readFileSync(join(directory, readme), "utf8"));
  return section === null ? null : `(No licence file; from the package's README.)\n\n${section}`;
}

/**
 * Packages a stylesheet pulls in with bare @import specifiers, such as
 * `@import "tailwindcss"`. CSS tools inline these themselves, so they never
 * appear among the bundler's modules.
 */
export function cssImportedPackages(css: string): string[] {
  const names = new Set<string>();
  for (const match of css.matchAll(/@import\s+(?:url\()?["']([^"']+)["']/g)) {
    const specifier = match[1] ?? "";
    if (specifier.startsWith(".") || specifier.startsWith("/") || /^[a-z]+:/i.test(specifier)) {
      continue;
    }
    const parts = specifier.split("/");
    names.add(parts.slice(0, specifier.startsWith("@") ? 2 : 1).join("/"));
  }
  return [...names];
}

/** Where Node.js would find a package from this directory, or null. */
function findPackage(name: string, fromDirectory: string): string | null {
  for (let directory = fromDirectory; ; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) {
      return candidate;
    }
    if (dirname(directory) === directory) {
      return null;
    }
  }
}

/** The packages behind these module IDs, each once, sorted by name. */
export function bundledPackages(moduleIds: Iterable<string>): BundledPackage[] {
  const directories = new Set<string>();
  for (const id of moduleIds) {
    const directory = packageDirectory(id);
    if (directory !== null && existsSync(join(directory, "package.json"))) {
      directories.add(directory);
    }
  }
  const packages = new Map<string, BundledPackage>();
  for (const directory of directories) {
    const found = readPackage(directory);
    packages.set(`${found.name}@${found.version}`, found);
  }
  return [...packages.values()].toSorted(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

const RULE = "=".repeat(72);

export function licensesText(packages: readonly BundledPackage[]): string {
  const sections = packages.map((found) =>
    [
      RULE,
      `${found.name} ${found.version} (${found.license})`,
      RULE,
      "",
      found.text ??
        "The package ships no licence file; its package.json declares the licence above.",
    ].join("\n"),
  );
  return [
    "Third-party software in this build",
    "",
    "This build includes code from the npm packages below, each under its own",
    "licence, reproduced as the package ships it.",
    "",
    ...sections.flatMap((section) => [section, ""]),
  ].join("\n");
}

/** The parts of the bundler's plugin context this plugin uses. */
interface BundleContext {
  getModuleIds(): IterableIterator<string>;
  emitFile(file: { type: "asset"; fileName: string; source: string }): string;
}

export function thirdPartyLicenses({
  stylesheets = [],
}: {
  /** Absolute paths of stylesheets whose @import packages the build copies. */
  stylesheets?: readonly string[];
} = {}) {
  return {
    name: "ottertrail:third-party-licenses",
    generateBundle(this: BundleContext) {
      const fromStylesheets = stylesheets.flatMap((stylesheet) =>
        cssImportedPackages(readFileSync(stylesheet, "utf8")).map((name) => {
          const directory = findPackage(name, dirname(stylesheet));
          if (directory === null) {
            throw new Error(`${stylesheet} imports ${name}, which is not installed`);
          }
          return `${directory}/package.json`;
        }),
      );
      const packages = bundledPackages([...this.getModuleIds(), ...fromStylesheets]);
      // Both builds bundle npm packages; none found means module IDs this
      // plugin does not understand, and a release without their licences.
      if (packages.length === 0) {
        throw new Error("found no bundled npm packages to list in " + LICENSES_FILE_NAME);
      }
      this.emitFile({
        type: "asset",
        fileName: LICENSES_FILE_NAME,
        source: licensesText(packages),
      });
    },
  };
}
