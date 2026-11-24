/**
 * Release notes follow docs/development.md, "Commits". Final releases include changes from release
 * candidates; prereleases start at the previous version tag.
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const IMAGE = "ghcr.io/ottertrail/ottertrail";
const RELEASES = "https://github.com/ottertrail/ottertrail/releases";

export interface Commit {
  hash: string;
  subject: string;
  body: string;
}

export type Section = "breaking" | "features" | "fixes" | "other";

export interface Entry {
  section: Section;
  /** The subject without its type and scope. */
  text: string;
  hash: string;
}

const HEADER = /^(?<type>[a-z]+)(?:\([^()]*\))?(?<bang>!)?: (?<text>.+)$/;
// The footer as Conventional Commits writes it, at the start of a line.
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE: /m;
// The commit `vp run version` asks for: it changes only the version.
const RELEASE_COMMIT = /^chore\(release\): /;

/** Sorts one commit into its section; null for a release commit. */
export function entryFor(commit: Commit): Entry | null {
  if (RELEASE_COMMIT.test(commit.subject)) return null;
  const header = HEADER.exec(commit.subject)?.groups;
  if (header === undefined) {
    // Not a Conventional Commit, such as a merge: kept whole, under Other.
    return { section: "other", text: commit.subject, hash: commit.hash };
  }
  const { type = "", bang, text = "" } = header;
  let section: Section = "other";
  if (bang !== undefined || BREAKING_FOOTER.test(commit.body)) section = "breaking";
  else if (type === "feat") section = "features";
  else if (type === "fix") section = "fixes";
  return { section, text, hash: commit.hash };
}

/** Quote @names to prevent GitHub mentions; leave email addresses unchanged. */
export function noMentions(text: string): string {
  return text.replace(/(^|[^\w`])(@\w[\w-]*(?:\/[\w.-]*\w)?)/g, "$1`$2`");
}

const TITLES: Record<Section, string> = {
  breaking: "Breaking changes",
  features: "Features",
  fixes: "Fixes",
  other: "Other",
};

/** The notes, for commits listed newest first, as `git log` lists them. */
export function renderNotes(version: string, commits: Commit[], since: string | null): string {
  const image = `${IMAGE}:${version}`;
  const lines = [
    `The image is \`${image}\`, for linux/amd64 and linux/arm64.`,
    since === null
      ? "The first release: the changes below are the whole history."
      : `Changes since ${since}:`,
  ];
  const entries = commits.map(entryFor).filter((entry) => entry !== null);
  for (const section of ["breaking", "features", "fixes", "other"] as const) {
    const inSection = entries.filter((entry) => entry.section === section);
    if (inSection.length === 0) continue;
    lines.push("", `## ${TITLES[section]}`, "");
    for (const entry of inSection) lines.push(`- ${noMentions(entry.text)} (${entry.hash})`);
  }
  if (entries.length === 0) lines.push("", "No changes besides the version.");
  lines.push(
    "",
    "## Install or update",
    "",
    "A new install, in an empty folder ([docs/deployment.md](https://github.com/ottertrail/ottertrail/blob/main/docs/deployment.md) has the details):",
    "",
    "```sh",
    `curl -fLO ${RELEASES}/download/v${version}/compose.yaml`,
    `curl -fLO ${RELEASES}/download/v${version}/example.env`,
    `curl -fLO ${RELEASES}/download/v${version}/backup.sh`,
    `curl -fLO ${RELEASES}/download/v${version}/restore.sh`,
    "chmod +x backup.sh restore.sh",
    "cp example.env .env   # then fill it in",
    "docker compose up -d",
    "```",
    "",
    "To update an install, back it up, replace its `compose.yaml` with this release's (or set `OTTERTRAIL_VERSION=" +
      version +
      "` in `.env`), then:",
    "",
    "```sh",
    "./backup.sh",
    "docker compose pull",
    "docker compose up -d",
    "```",
    "",
  );
  return lines.join("\n");
}

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function isFinal(version: string): boolean {
  return !version.includes("-");
}

/** For final releases, skip prerelease tags. Return null when no earlier tag exists. */
export function previousTag(ref: string, final: boolean, cwd?: string): string | null {
  const exclude = final ? ["--exclude", "v*-*"] : [];
  try {
    return git(
      ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", ...exclude, `${ref}^`],
      cwd,
    ).trim();
  } catch {
    // No earlier tag, or ref is the first commit.
    return null;
  }
}

/** The commits after previous up to ref, newest first; all of them without previous. */
export function commitsBetween(previous: string | null, ref: string, cwd?: string): Commit[] {
  const range = previous === null ? ref : `${previous}..${ref}`;
  // Fields end with a unit separator, commits with a record separator:
  // neither appears in a commit message.
  const out = git(["log", "--no-merges", "--format=%h%x1f%s%x1f%b%x1e", range], cwd);
  return out
    .split("\u001e")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record !== "")
    .map((record) => {
      const [hash = "", subject = "", body = ""] = record.split("\u001f");
      return { hash, subject, body };
    });
}

export function notesFor(version: string, ref = `v${version}`, cwd?: string): string {
  const previous = previousTag(ref, isFinal(version), cwd);
  return renderNotes(version, commitsBetween(previous, ref, cwd), previous);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [version, ref] = process.argv.slice(2);
  if (version === undefined || version === "") {
    console.error("Usage: node scripts/release-notes.ts <version> [<ref>]");
    process.exit(1);
  }
  process.stdout.write(notesFor(version, ref));
}
