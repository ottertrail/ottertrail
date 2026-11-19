import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import {
  checkVersion,
  isSemver,
  PLACES,
  readVersions,
  setVersion,
} from "../../../scripts/version.ts";

const repo = join(import.meta.dirname, "../../..");

describe("isSemver", () => {
  test.each(["0.1.0", "1.0.0", "10.20.30", "1.0.0-rc.1", "1.0.0-alpha.beta+build.5", "0.0.0"])(
    "accepts %s",
    (version) => {
      expect(isSemver(version)).toBe(true);
    },
  );

  test.each([
    "v0.1.0",
    "0.1",
    "1",
    "01.0.0",
    "1.0.0-",
    "1.0.0 ",
    "",
    "latest",
    "1.0.0-01",
    "1.0.0/../x",
  ])("refuses %j", (version) => {
    expect(isSemver(version)).toBe(false);
  });
});

describe("the repository", () => {
  test("holds one version in all three places", () => {
    const versions = Object.values(readVersions(repo));
    expect(versions).toHaveLength(3);
    expect(new Set(versions).size).toBe(1);
    expect(checkVersion(repo, versions[0] ?? "")).toEqual([]);
  });
});

describe("setVersion", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ottertrail-version-"));
    for (const { file } of PLACES) {
      mkdirSync(join(root, file, ".."), { recursive: true });
      cpSync(join(repo, file), join(root, file));
    }
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("sets all three, and changes nothing else", () => {
    const before = PLACES.map(({ file }) => readFileSync(join(root, file), "utf8"));
    const old = readVersions(root)["package.json"] ?? "";
    setVersion(root, "12.3.4-rc.1");
    expect(Object.values(readVersions(root))).toEqual([
      "12.3.4-rc.1",
      "12.3.4-rc.1",
      "12.3.4-rc.1",
    ]);
    expect(checkVersion(root, "12.3.4-rc.1")).toEqual([]);
    PLACES.forEach(({ file }, index) => {
      const after = readFileSync(join(root, file), "utf8");
      expect(after.replace("12.3.4-rc.1", old)).toBe(before[index]);
    });
    // The pnpm version in devEngines is not the release's.
    expect(readFileSync(join(root, "package.json"), "utf8")).toContain('"version": "12.21.0"');
  });

  test("refuses a version that is not semantic, and writes nothing", () => {
    const before = readVersions(root);
    expect(() => setVersion(root, "v1.2.3")).toThrow("Not a semantic version");
    expect(() => setVersion(root, "1.2")).toThrow("Not a semantic version");
    expect(readVersions(root)).toEqual(before);
  });

  test("writes nothing when one place has no version to replace", () => {
    const packages = ["package.json", "apps/api/package.json"].map((file) =>
      readFileSync(join(root, file), "utf8"),
    );
    // A compose file without the image line.
    writeFileSync(join(root, "deploy/compose.yaml"), "services:\n  api:\n    build: ..\n");
    expect(() => setVersion(root, "2.0.0")).toThrow("No version found in deploy/compose.yaml");
    expect(
      ["package.json", "apps/api/package.json"].map((file) =>
        readFileSync(join(root, file), "utf8"),
      ),
    ).toEqual(packages);
  });

  test("refuses build metadata, which a Docker tag cannot hold", () => {
    const before = readVersions(root);
    expect(isSemver("1.0.0+b1")).toBe(true);
    expect(() => setVersion(root, "1.0.0+b1")).toThrow("Build metadata");
    expect(() => setVersion(root, "1.0.0-rc.1+b1")).toThrow("Build metadata");
    expect(readVersions(root)).toEqual(before);
    expect(checkVersion(root, "1.0.0+b1")).toEqual([
      'Build metadata ("+…") is not allowed in a release version. Docker tags cannot contain "+": 1.0.0+b1',
    ]);
  });

  test("leaves no temporary file behind", () => {
    setVersion(root, "3.0.0");
    for (const dir of [".", "apps/api", "deploy"]) {
      expect(readdirSync(join(root, dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    }
  });

  test("writes nothing when one file cannot be written", () => {
    const before = PLACES.map(({ file }) => readFileSync(join(root, file), "utf8"));
    // deploy/ refuses new files: the third temporary file cannot be made.
    chmodSync(join(root, "deploy"), 0o555);
    try {
      expect(() => setVersion(root, "4.0.0")).toThrow(/EACCES|permission denied/i);
    } finally {
      chmodSync(join(root, "deploy"), 0o755);
    }
    expect(PLACES.map(({ file }) => readFileSync(join(root, file), "utf8"))).toEqual(before);
    for (const dir of [".", "apps/api", "deploy"]) {
      expect(readdirSync(join(root, dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    }
  });

  test("checkVersion names each place that differs", () => {
    expect(checkVersion(root, "9.9.9")).toHaveLength(3);
    expect(checkVersion(root, "9.9.9")[2]).toMatch(/^deploy\/compose\.yaml has .+, not 9\.9\.9$/);
  });
});

describe("the command", () => {
  const script = join(repo, "scripts/version.ts");

  test("--check passes for the repository's version, and fails for another", () => {
    const version = readVersions(repo)["package.json"] ?? "";
    expect(() =>
      execFileSync("node", [script, "--check", version], { stdio: "pipe" }),
    ).not.toThrow();
    expect(() => execFileSync("node", [script, "--check", "99.0.0"], { stdio: "pipe" })).toThrow(
      /package\.json has .+, not 99\.0\.0/,
    );
  });

  test("--check refuses build metadata", () => {
    expect(() => execFileSync("node", [script, "--check", "0.1.0+b1"], { stdio: "pipe" })).toThrow(
      /Build metadata/,
    );
  });

  test("refuses a version that is not semantic", () => {
    expect(() => execFileSync("node", [script, "1.2"], { stdio: "pipe" })).toThrow(
      /Not a semantic version/,
    );
  });
});
