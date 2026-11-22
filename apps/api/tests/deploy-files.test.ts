import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "vite-plus/test";

import { DEVELOPMENT_GARAGE_ADMIN_TOKEN, GARAGE_ADMIN_PORT } from "../src/config.ts";

const deploy = join(import.meta.dirname, "../../../deploy");
const compose = readFileSync(join(deploy, "compose.yaml"), "utf8");

/**
 * A config's inline content in compose.yaml: the literal block under
 * `configs: <name>: content: |`, without its indentation.
 */
function inlineConfig(name: string): string {
  const lines = compose.split("\n");
  const top = lines.indexOf("configs:");
  expect(top, "compose.yaml has a top-level configs: section").toBeGreaterThan(-1);
  const start = lines.indexOf(`  ${name}:`, top);
  expect(start, `compose.yaml has the config ${name}`).toBeGreaterThan(-1);
  expect(lines[start + 1]).toBe("    content: |");
  const body: string[] = [];
  for (const line of lines.slice(start + 2)) {
    if (line !== "" && !line.startsWith("      ")) break;
    body.push(line.slice(6));
  }
  // A literal block keeps one final newline; blank lines before the next
  // key belong to the YAML, not to the file.
  return `${body.join("\n").trimEnd()}\n`;
}

// The development stack (compose.yaml at the repository root) reads these
// files; installs get the same settings inline. One must not drift.
describe("deploy/compose.yaml's inline settings match the files the development stack reads", () => {
  test.each([
    ["clickhouse-config", "clickhouse/config.d/ottertrail.xml"],
    ["clickhouse-users", "clickhouse/users.d/ottertrail.xml"],
    ["garage", "garage/garage.toml"],
  ])("%s is %s", (name, file) => {
    expect(inlineConfig(name)).toBe(readFileSync(join(deploy, file), "utf8"));
  });
});

describe("deploy/compose.yaml works on its own, as a release download", () => {
  test("it runs the published image, and builds nothing", () => {
    expect(compose).toMatch(
      /^ {2}image: ghcr\.io\/ottertrail\/ottertrail:\$\{OTTERTRAIL_VERSION:-[^}]+\}$/m,
    );
    expect(compose).not.toMatch(/^\s*build:/m);
  });

  // Docker Compose before 5.0.2 evaluates a check inside a condition
  // (${A:-${B:+${A:?…}}}) in every install. So Compose checks only what
  // every install needs, and the services check the rest as they start.
  test("Compose requires only what every install needs, with flat checks", () => {
    expect(compose).not.toContain(":+");
    const required = new Set([...compose.matchAll(/\$\{(\w+):\?/g)].map((match) => match[1] ?? ""));
    expect([...required].toSorted((a, b) => a.localeCompare(b))).toEqual([
      "AUTH_SECRET",
      "CLICKHOUSE_PASSWORD",
      "OTTERTRAIL_DOMAIN",
      "POSTGRES_PASSWORD",
    ]);
  });

  test("it mounts no file from beside it", () => {
    expect(compose).not.toMatch(/^\s*- \.{1,2}\//m);
  });

  test("the worker writes the location data where the API reads it, both read-write", () => {
    for (const service of ["api", "worker"]) {
      const start = compose.indexOf(`\n  ${service}:\n`);
      const end = compose.indexOf("\n\n", start);
      expect(start, `compose.yaml has the ${service} service`).toBeGreaterThan(-1);
      expect(compose.slice(start, end)).toContain("    volumes:\n      - geo-data:/app/data/geo\n");
    }
  });

  test("only the worker gets the backup destination, optional, beside the shared settings", () => {
    const names = [
      "BACKUP_S3_ENDPOINT",
      "BACKUP_S3_REGION",
      "BACKUP_S3_BUCKET",
      "BACKUP_S3_PREFIX",
      "BACKUP_S3_ACCESS_KEY_ID",
      "BACKUP_S3_SECRET_ACCESS_KEY",
    ];
    const worker = serviceBlock(compose, "worker");
    expect(worker).toContain("    environment:\n      <<: *app-environment\n");
    for (const name of names) expect(worker).toContain(`      ${name}: \${${name}:-}\n`);
    // Not in the settings the API and migrate get, nor in any other service.
    expect(compose.replace(worker, "")).not.toContain("BACKUP_S3_");
    expect(compose).toContain("  environment: &app-environment\n");
    // example.env lists them, commented out.
    const example = readFileSync(join(deploy, "example.env"), "utf8");
    for (const name of names) expect(example).toMatch(new RegExp(`^# ${name}=`, "m"));
  });

  test("Caddy reads the domain from its environment, so a new domain recreates it", () => {
    // $$ is a literal dollar sign for Compose: Caddy reads {$OTTERTRAIL_DOMAIN}.
    expect(inlineConfig("caddyfile").split("\n")[0]).toBe("{$$OTTERTRAIL_DOMAIN} {");
    expect(compose).toContain(
      "    environment:\n      OTTERTRAIL_DOMAIN: ${OTTERTRAIL_DOMAIN:?set OTTERTRAIL_DOMAIN in .env}\n",
    );
  });
});

// Compose recreates a container when its labels change, but not when only
// the content of one of its configs does. A label with each config's hash
// makes a changed config recreate the service that reads it.
describe("each service that reads a config carries the config's hash", () => {
  test.each(["caddyfile", "clickhouse-config", "clickhouse-users", "garage"])("%s", (name) => {
    const hash = createHash("sha256").update(inlineConfig(name)).digest("hex").slice(0, 12);
    const labels = compose.match(new RegExp(`^ {6}ottertrail\\.config\\.${name}: .*$`, "gm")) ?? [];
    expect(labels).toEqual([`      ottertrail.config.${name}: "${hash}"`]);
  });
});

/** A service's block in a compose file: from its name to the next blank line. */
function serviceBlock(file: string, service: string): string {
  const start = file.indexOf(`\n  ${service}:\n`);
  expect(start, `the compose file has the ${service} service`).toBeGreaterThan(-1);
  const end = file.indexOf("\n\n", start + 1);
  return file.slice(start, end === -1 ? undefined : end);
}

/**
 * Runs backup.sh with a stand-in for `docker compose` that answers the
 * free-space queries, then fails the dump: the script stops there.
 */
async function run(figures: { free: string; data: string; objects: string }) {
  const folder = await mkdtemp(join(tmpdir(), "ottertrail-backup-"));
  try {
    await copyFile(join(deploy, "backup.sh"), join(folder, "backup.sh"));
    const fake = join(folder, "fake-compose");
    await writeFile(
      fake,
      `#!/bin/sh
case "$*" in
  *"system.disks"*) echo "${figures.free}" ;;
  *"system.parts"*) echo "${figures.data}" ;;
  *"from replays"*) echo "${figures.objects}" ;;
  *pg_dump*) exit 1 ;;
  *) exit 0 ;;
esac
`,
    );
    await chmod(fake, 0o755);
    try {
      await promisify(execFile)("sh", [join(folder, "backup.sh")], {
        env: { ...process.env, COMPOSE: fake },
      });
      throw new Error("backup.sh went past the failed dump");
    } catch (error) {
      const { stdout, stderr } = error as { stdout: string; stderr: string };
      return { stdout, stderr };
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

describe("storage: Garage's admin API, the free-disk floor, and backup.sh", () => {
  const exampleSettings = readFileSync(join(deploy, "example.env"), "utf8");
  const development = readFileSync(join(deploy, "../compose.yaml"), "utf8");

  test("Garage serves its admin API on 3903, inside the Compose network only", () => {
    const toml = readFileSync(join(deploy, "garage/garage.toml"), "utf8");
    expect(toml).toMatch(/^\[admin\]\napi_bind_addr = "\[::\]:3903"$/m);
    // /metrics needs a metrics token, and none is set: refused to everyone.
    expect(toml).toMatch(/^metrics_require_token = true$/m);
    expect(toml).not.toMatch(/metrics_token\s*=/);
    expect(GARAGE_ADMIN_PORT).toBe(3903);
    // No token in the file: it comes from the environment.
    expect(toml).not.toMatch(/admin_token/);
    const garage = serviceBlock(compose, "garage");
    expect(garage).not.toMatch(/^ {4}ports:/m);
    expect(garage).toContain("      GARAGE_ADMIN_TOKEN: ${GARAGE_ADMIN_TOKEN:-}\n");
  });

  test("the API, the worker, and migrate get the same optional token", () => {
    const app = compose.slice(compose.indexOf("x-app: &app"), compose.indexOf("\nservices:"));
    expect(app).toContain("    GARAGE_ADMIN_TOKEN: ${GARAGE_ADMIN_TOKEN:-}\n");
    // Optional: Compose does not require it.
    expect(compose).not.toContain("GARAGE_ADMIN_TOKEN:?");
  });

  test("example settings list the token, empty, with how to generate it", () => {
    expect(exampleSettings).toMatch(/^GARAGE_ADMIN_TOKEN=$/m);
    expect(exampleSettings).toMatch(/^# {3}GARAGE_ADMIN_TOKEN: +openssl rand -hex 32$/m);
  });

  test("the development Garage has the token the API's development default sends, on 127.0.0.1", () => {
    const garage = serviceBlock(development, "garage");
    expect(garage).toContain(`      GARAGE_ADMIN_TOKEN: ${DEVELOPMENT_GARAGE_ADMIN_TOKEN}\n`);
    expect(garage).toContain(`      - "127.0.0.1:3903:3903"\n`);
  });

  test("ClickHouse refuses inserts under 5% free disk, in both stacks", () => {
    // The development stack mounts this file; installs hold the same inline (above).
    const config = readFileSync(join(deploy, "clickhouse/config.d/ottertrail.xml"), "utf8");
    expect(config).toMatch(
      /<merge_tree>\s*<min_free_disk_ratio_to_perform_insert>0\.05<\/min_free_disk_ratio_to_perform_insert>\s*<\/merge_tree>/,
    );
    expect(development).toContain(
      "./deploy/clickhouse/config.d/ottertrail.xml:/etc/clickhouse-server/config.d/ottertrail.xml:ro",
    );
  });

  describe("backup.sh says how much free space it has and needs", () => {
    const GiB = 1024 ** 3;

    test("enough: prints the free space and the need, and warns of nothing", async () => {
      const { stdout, stderr } = await run({
        free: String(1000 * GiB),
        data: String(1 * GiB),
        objects: String(GiB / 2),
      });
      expect(stdout).toMatch(
        /^Free space: 1000\.0 GiB on ClickHouse's disk, [\d.]+ GiB for backups\/\. Needs about 3\.0 GiB\.$/m,
      );
      expect(stderr).not.toContain("Warning");
      expect(stderr).toContain("Backup failed while dumping PostgreSQL.");
    });

    test("too little: warns, and goes on to the backup", async () => {
      const { stdout, stderr } = await run({
        free: String(2 * GiB),
        data: String(1 * GiB),
        objects: String(GiB / 2),
      });
      expect(stdout).toContain("Free space: 2.0 GiB on ClickHouse's disk");
      expect(stderr).toContain(
        "Warning: insufficient free space. Backup may fail and keep no files.",
      );
      // It went on: the dump was tried.
      expect(stderr).toContain("Backup failed while dumping PostgreSQL.");
    });

    test("one figure unmeasured: says so, skips the comparison, and goes on", async () => {
      for (const figures of [
        { free: String(1000 * GiB), data: "", objects: String(GiB) },
        { free: "", data: String(GiB), objects: String(GiB) },
        { free: String(1000 * GiB), data: String(GiB), objects: "ERROR: relation missing" },
      ]) {
        const { stdout, stderr } = await run(figures);
        expect(stderr).toContain("Couldn't measure free space. Continuing;");
        expect(stdout).not.toContain("Free space:");
        expect(stderr).not.toContain("Warning");
        expect(stderr).toContain("Backup failed while dumping PostgreSQL.");
      }
    });

    test("unmeasured: says so, and goes on", async () => {
      const { stderr } = await run({ free: "", data: "", objects: "" });
      expect(stderr).toContain("Couldn't measure free space. Continuing;");
      expect(stderr).toContain("Backup failed while dumping PostgreSQL.");
    });
  });
});

describe("restore.sh reads the backup variables from the file beside it as Compose does", () => {
  const script = readFileSync(join(deploy, "restore.sh"), "utf8");
  const reader = script.slice(
    script.indexOf("  # from_env_file: start"),
    script.indexOf("  # from_env_file: end"),
  );

  /** What restore.sh's reader returns for `name` from a file holding `text`. */
  async function readValue(text: string, name: string): Promise<string> {
    const folder = await mkdtemp(join(tmpdir(), "ottertrail-env-reader-"));
    try {
      const file = join(folder, "settings");
      await writeFile(file, text);
      const { stdout } = await promisify(execFile)("sh", [
        "-c",
        `env_file="$1"\n${reader}\nfrom_env_file "$2"`,
        "sh",
        file,
        name,
      ]);
      return stdout;
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  test.each([
    ["A=plain", "plain"],
    ["A=plain   ", "plain"],
    ["A= spaced", "spaced"],
    ["A=plain\r", "plain"],
    ["A=plain # a comment", "plain"],
    ["A=no#comment", "no#comment"],
    ['A="quoted"', "quoted"],
    ['A="quoted"   ', "quoted"],
    ['A="quoted"\r', "quoted"],
    ['A="pre" # c', "pre"],
    ['A="has # inside"', "has # inside"],
    ["A='single' # c", "single"],
    ["A=key=with=equals", "key=with=equals"],
    ['A="x=y"', "x=y"],
    ["export A=exported", "exported"],
    ["  A = around", "around"],
    ["A=", ""],
    ["# A=commented", ""],
    ["AB=other", ""],
  ])("%j reads as %j", async (line, expected) => {
    expect(await readValue(`OTHER=1\n${line}\n`, "A")).toBe(expected);
  });

  test("the last line wins, in a file with CRLF line ends", async () => {
    expect(await readValue("A=first\r\nB=b\r\nA=second\r\n", "A")).toBe("second");
  });

  test("it never runs the file", async () => {
    expect(await readValue("A=$(echo ran)\nB=`echo ran`\n", "A")).toBe("$(echo ran)");
    expect(reader).not.toMatch(/\beval\b|^\s*\.\s|\bsource\b/m);
  });
});
