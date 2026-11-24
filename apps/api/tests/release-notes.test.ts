import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import {
  type Commit,
  commitsBetween,
  entryFor,
  noMentions,
  notesFor,
  previousTag,
  renderNotes,
} from "../../../scripts/release-notes.ts";

const repo = join(import.meta.dirname, "../../..");

function commit(subject: string, body = "", hash = "abc1234"): Commit {
  return { hash, subject, body };
}

describe("entryFor", () => {
  test.each([
    ["feat(api): add event ingestion", "features", "add event ingestion"],
    ["feat: saved goals", "features", "saved goals"],
    ["fix(web): keep the sidebar open after reload", "fixes", "keep the sidebar open after reload"],
    ["docs: the release flow", "other", "the release flow"],
    ["ci: build release images", "other", "build release images"],
    ["feat(sdk)!: rename init() to start()", "breaking", "rename init() to start()"],
    ["refactor!: one customer per instance", "breaking", "one customer per instance"],
    ["Merge branch 'main'", "other", "Merge branch 'main'"],
    ["feat:no space is not conventional", "other", "feat:no space is not conventional"],
  ])("%s", (subject, section, text) => {
    expect(entryFor(commit(subject))).toEqual({ section, text, hash: "abc1234" });
  });

  test("a BREAKING CHANGE footer makes any type breaking", () => {
    const body = "Longer text.\n\nBREAKING CHANGE: the old endpoint is gone.\n";
    expect(entryFor(commit("fix(api): drop /api/v0", body))?.section).toBe("breaking");
    expect(entryFor(commit("feat: x", "BREAKING-CHANGE: y"))?.section).toBe("breaking");
  });

  test("the words alone, not as a footer, do not", () => {
    expect(
      entryFor(commit("docs: explain when to write BREAKING CHANGE: in a footer"))?.section,
    ).toBe("other");
    expect(entryFor(commit("feat: x", "No BREAKING CHANGE: here"))?.section).toBe("features");
  });

  test("leaves out the release commit", () => {
    expect(entryFor(commit("chore(release): 0.2.0"))).toBeNull();
  });
});

describe("renderNotes", () => {
  const notes = renderNotes(
    "1.2.0",
    [
      commit("fix: second fix", "", "0000004"),
      commit("chore(release): 1.2.0", "", "0000005"),
      commit("feat(web): a page", "", "0000003"),
      commit("docs: words", "", "0000002"),
      commit("feat(api)!: a new key format", "", "0000001"),
      commit("fix: first fix", "", "0000000"),
    ],
    "v1.1.0",
  );

  test("names the image", () => {
    expect(notes.split("\n")[0]).toBe(
      "The image is `ghcr.io/ottertrail/ottertrail:1.2.0`, for linux/amd64 and linux/arm64.",
    );
    expect(notes).toContain("Changes since v1.1.0:");
  });

  test("puts breaking changes first, then features, fixes, and other, newest first in each", () => {
    const headings = notes.split("\n").filter((line) => line.startsWith("## "));
    expect(headings).toEqual([
      "## Breaking changes",
      "## Features",
      "## Fixes",
      "## Other",
      "## Install or update",
    ]);
    const items = notes.split("\n").filter((line) => line.startsWith("- "));
    expect(items).toEqual([
      "- a new key format (0000001)",
      "- a page (0000003)",
      "- second fix (0000004)",
      "- first fix (0000000)",
      "- words (0000002)",
    ]);
  });

  test("shows how to install or update this release", () => {
    expect(notes).toContain("(https://docs.ottertrail.app/get-started/install/)");
    expect(notes).toContain("releases/download/v1.2.0/compose.yaml");
    expect(notes).toContain("releases/download/v1.2.0/example.env");
    // The repository is public: plain curl downloads, with no sign-in workaround.
    expect(notes).not.toContain("gh release download");
    expect(notes).toContain("OTTERTRAIL_VERSION=1.2.0");
    expect(notes).toContain("docker compose pull\ndocker compose up -d");
    // The release ships no firewall script: the host's own firewall does that job.
    expect(notes).not.toContain("firewall");
  });

  test("leaves out empty sections", () => {
    const only = renderNotes("1.0.1", [commit("fix: one")], "v1.0.0");
    expect(only.split("\n").filter((line) => line.startsWith("## "))).toEqual([
      "## Fixes",
      "## Install or update",
    ]);
    const none = renderNotes("1.0.1", [commit("chore(release): 1.0.1")], "v1.0.0");
    expect(none).toContain("No changes besides the version.");
  });

  test("says when it is the first release", () => {
    expect(renderNotes("0.1.0", [], null)).toContain("The first release");
  });
});

// A first release, then the next, in a repository of its own.
describe("a first release and the one after it", () => {
  let dir: string;
  const hashes: Record<string, string> = {};
  const run = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "tag.gpgSign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { cwd: dir, encoding: "utf8" },
    ).trim();
  const commitAndTag = (subject: string, tag?: string) => {
    run("commit", "--allow-empty", "-q", "-m", subject);
    hashes[subject] = run("rev-parse", "--short", "HEAD");
    if (tag !== undefined) run("tag", tag);
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ottertrail-notes-"));
    run("init", "-q");
    commitAndTag("feat: the first commit");
    commitAndTag("feat!: a breaking change");
    commitAndTag("fix: a fix");
    commitAndTag("chore(release): 0.1.0", "v0.1.0");
    commitAndTag("feat: after the first release");
    commitAndTag("chore(release): 0.2.0");
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a first release's notes cover every commit but the release commit", () => {
    expect(previousTag("v0.1.0", true, dir)).toBeNull();
    expect(commitsBetween(null, "v0.1.0", dir)).toHaveLength(4);
    const notes = notesFor("0.1.0", undefined, dir);
    expect(notes.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(3);
    expect(notes).not.toContain("chore(release)");
    const breaking = notes.slice(
      notes.indexOf("## Breaking changes"),
      notes.indexOf("## Features"),
    );
    expect(breaking).toContain(`(${hashes["feat!: a breaking change"]})`);
    expect(notes).toContain(`(${hashes["feat: the first commit"]})`);
  });

  test("the notes for HEAD cover the commits since the latest earlier release", () => {
    const head = run("rev-parse", "HEAD");
    expect(previousTag(head, true, dir)).toBe("v0.1.0");
    expect(commitsBetween("v0.1.0", head, dir)).toHaveLength(2);
    const notes = notesFor("0.2.0", head, dir);
    expect(notes).toContain("Changes since v0.1.0:");
    expect(notes).toContain(
      `- after the first release (${hashes["feat: after the first release"]})`,
    );
    expect(notes).not.toContain("a fix");
    expect(notes).not.toContain("chore(release)");
  });

  test("the command prints the same notes", () => {
    const out = execFileSync("node", [join(repo, "scripts/release-notes.ts"), "0.1.0"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(out).toBe(notesFor("0.1.0", undefined, dir));
  });
});

describe("noMentions", () => {
  test.each([
    ["bump @types/node to 26", "bump `@types/node` to 26"],
    ["thanks @alice and @org/team.", "thanks `@alice` and `@org/team`."],
    ["@start of the subject", "`@start` of the subject"],
    ["mail a@b.example", "mail a@b.example"],
    ["already `@quoted`", "already `@quoted`"],
  ])("%s", (text, expected) => {
    expect(noMentions(text)).toBe(expected);
  });

  test("the notes mention nobody", () => {
    const notes = renderNotes("1.0.1", [commit("build(deps): bump @types/node")], "v1.0.0");
    expect(notes).toContain("- bump `@types/node` (abc1234)");
  });
});

// A release candidate, then its final release, in a repository of its own.
describe("a final release after its release candidate", () => {
  let dir: string;
  const hashes: Record<string, string> = {};
  const run = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "tag.gpgSign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { cwd: dir, encoding: "utf8" },
    ).trim();
  const commitAndTag = (subject: string, tag?: string) => {
    run("commit", "--allow-empty", "-q", "-m", subject);
    hashes[subject] = run("rev-parse", "--short", "HEAD");
    if (tag !== undefined) run("tag", tag);
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ottertrail-notes-"));
    run("init", "-q");
    commitAndTag("feat: the first feature", "v0.1.0");
    commitAndTag("feat: before the candidate");
    commitAndTag("chore(release): 0.2.0-rc.1", "v0.2.0-rc.1");
    commitAndTag("fix: after the candidate");
    commitAndTag("chore(release): 0.2.0", "v0.2.0");
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("the candidate's notes count from the previous release", () => {
    expect(previousTag("v0.2.0-rc.1", false, dir)).toBe("v0.1.0");
    const notes = notesFor("0.2.0-rc.1", undefined, dir);
    expect(notes).toContain(`- before the candidate (${hashes["feat: before the candidate"]})`);
    expect(notes).not.toContain("after the candidate");
  });

  test("the final release's notes include what came before its candidate", () => {
    expect(previousTag("v0.2.0", true, dir)).toBe("v0.1.0");
    const notes = notesFor("0.2.0", undefined, dir);
    expect(notes).toContain("Changes since v0.1.0:");
    expect(notes).toContain(`- before the candidate (${hashes["feat: before the candidate"]})`);
    expect(notes).toContain(`- after the candidate (${hashes["fix: after the candidate"]})`);
    expect(notes).not.toContain("the first feature");
  });

  test("a second candidate counts from the first, and its final release from 0.2.0", () => {
    commitAndTag("fix: in the first candidate", "v0.3.0-rc.1");
    commitAndTag("fix: in the second candidate", "v0.3.0-rc.2");
    commitAndTag("chore(release): 0.3.0", "v0.3.0");
    expect(previousTag("v0.3.0-rc.2", false, dir)).toBe("v0.3.0-rc.1");
    expect(previousTag("v0.3.0", true, dir)).toBe("v0.2.0");
  });
});
