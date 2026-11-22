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

describe("the image holds every tracker script the API serves", () => {
  const root = join(import.meta.dirname, "../../..");
  const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
  /** The tracker files the runtime image copies into ./tracker/. */
  const copied = (dockerfile.match(/^COPY --from=build (.+) \.\/tracker\/$/m)?.[1] ?? "")
    .split(/\s+/)
    .map((path) => path.replace("/src/packages/tracker/dist/", ""));
  /** The scripts the tracker's build makes, one per key of its `scripts`. */
  const trackerConfig = readFileSync(join(root, "packages/tracker/vite.config.ts"), "utf8");
  const built = [...trackerConfig.matchAll(/^ {2}(\w+): \{\s*entry: "/gm)].map(
    ([, name]) => `${name}.js`,
  );
  /** The files the API's script routes read from beside the tracker. */
  const routes = readFileSync(join(import.meta.dirname, "../src/tracker-script/routes.ts"), "utf8");
  const served = [...routes.matchAll(/join\(dirname\(scriptPath\), "([\w.-]+)"\)/g)].map(
    ([, name]) => name,
  );

  test("the build makes each script the API serves, and the image copies each", () => {
    expect(built).toContain("tracker.js");
    expect(served).toEqual(expect.arrayContaining(["v.js", "r.js", "h.js", "o.js"]));
    expect(built).toEqual(expect.arrayContaining(served));
    expect(copied.toSorted()).toEqual(built.toSorted());
  });
});

describe("restore.sh reads the backup variables from the file beside it as Compose does", () => {
  const script = readFileSync(join(deploy, "restore.sh"), "utf8");
  const reader = script.slice(
    script.indexOf("  # from_env_file: start"),
    script.indexOf("  # from_env_file: end"),
  );

  /**
   * What restore.sh's reader returns for `name` from a file holding
   * `text`, run with only PATH and `env` in its environment.
   */
  async function readValue(
    text: string,
    name: string,
    env: Record<string, string> = {},
  ): Promise<string> {
    const folder = await mkdtemp(join(tmpdir(), "ottertrail-env-reader-"));
    try {
      const file = join(folder, "settings");
      await writeFile(file, text);
      const { stdout } = await promisify(execFile)(
        "sh",
        ["-c", `env_file="$1"\n${reader}\nfrom_env_file "$2"`, "sh", file, name],
        { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env } },
      );
      return stdout;
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  /** The message the reader stops with for `name`, or "" when it does not stop. */
  async function refusal(text: string, name: string): Promise<string> {
    try {
      await readValue(text, name);
      return "";
    } catch (error) {
      return String((error as { stderr?: unknown }).stderr);
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

  describe("interpolation, as Compose does it", () => {
    const env = { S3_SECRET: "from-shell", EMPTY: "" };
    test.each([
      ["A=${S3_SECRET}", "from-shell"],
      ["A=$S3_SECRET", "from-shell"],
      ['A="${S3_SECRET}"', "from-shell"],
      ["A=pre-${S3_SECRET}-post", "pre-from-shell-post"],
      ["A=$S3_SECRET.x", "from-shell.x"],
      ["A=${S3_SECRET:-fallback}", "from-shell"],
      ["A=${UNSET:-fallback}", "fallback"],
      ["A=${EMPTY:-fallback}", "fallback"],
      ["A=${UNSET}", ""],
      ["A=${IN_FILE}", "in-file"],
      ["A=$IN_FILE", "in-file"],
      ["A=${LITERAL}", "lit$eral"],
      ["A=cost$$5", "cost$5"],
      ["A=$$S3_SECRET", "$S3_SECRET"],
      ["A=a$", "a$"],
      ["A=a$ b", "a$ b"],
      ["A='${S3_SECRET}'", "${S3_SECRET}"],
      ["A='$S3_SECRET'", "$S3_SECRET"],
    ])("%j reads as %j", async (line, expected) => {
      const file = `IN_FILE=in-file\nLITERAL='lit$eral'\n${line}\n`;
      expect(await readValue(file, "A", env)).toBe(expected);
    });

    test("the shell's environment wins over the file", async () => {
      expect(await readValue("S3_SECRET=from-file\nA=${S3_SECRET}\n", "A", env)).toBe("from-shell");
    });

    test("a reference reads only the lines before it, as Compose does, each resolved in turn", async () => {
      // Defined after the line that uses it: unset there.
      expect(await readValue("A=${LATER}\nLATER=late\n", "A")).toBe("");
      // Redefined around the reference: the definition before it counts.
      expect(await readValue("B=first\nA=$B-${B}\nB=second\n", "A")).toBe("first-first");
      expect(await readValue("B=first\nB=second\nA=${B}\nB=third\n", "A")).toBe("second");
      // A chain, each from the lines before its own.
      expect(await readValue("C=c\nB=${C}b\nA=${B}a\n", "A")).toBe("cba");
      expect(await readValue("C=c\nB=$C\nC=x\nA=$B$C\n", "A")).toBe("cx");
      // A variable that refers to itself takes its own earlier value.
      expect(await readValue("A=one\nA=${A}-two\n", "A")).toBe("one-two");
    });

    test.each([
      ['A="ab\\$cd"', "ab$cd"],
      ['A="ab\\$S3_SECRET"', "ab$S3_SECRET"],
      ['A="x\\\\y"', "x\\y"],
      ['A="x\\\\$S3_SECRET"', "x\\from-shell"],
      ['A="say \\"hi\\"" # c', 'say "hi"'],
      ['A="a\\qb"', "a\\qb"],
      ["A='it\\'s'", "it's"],
      ["A='a\\$b\\\\'", "a\\$b\\\\"],
      ["A=a\\$B", "a\\b"],
    ])("escapes as Compose's dotenv parser reads them: %j reads as %j", async (line, expected) => {
      expect(await readValue(`B=b\n${line}\n`, "A", { S3_SECRET: "from-shell" })).toBe(expected);
    });

    test.each([
      ["A=${S3_SECRET:?unset}", "a ${...} form"],
      ["A=${S3_SECRET:+set}", "a ${...} form"],
      ["A=${UNSET:-$OTHER}", "a ${...} form"],
      ["A=${NO_END", "a ${...} form"],
      ["A=pre${CHAIN}", "a ${...} form"],
      ['A="a\\nb"', "an escape such as \\n in double quotes"],
      ['A="no end', "a quoted value that does not end on its line"],
      ['A="no end\\"', "a quoted value that does not end on its line"],
    ])("%j stops, saying to export the variable", async (line, form) => {
      expect(await refusal(`CHAIN=\${X:?y}\n${line}\n`, "A")).toBe(
        `A in .env uses ${form}, which restore.sh can't resolve. Export A in this shell, then run restore.sh again.\n`,
      );
    });

    test("the message never shows the value, nor runs a backslash in it", async () => {
      for (const line of [
        "A=${T0P_s3cret_part:?sk_live_t0psecret}",
        "A=t0psecret${NO_END_t0psecret",
        "A=${X:-t0psecret$Y}",
        'A="t0psecret\\n\\c"',
        'A="t0psecret',
      ]) {
        const message = await refusal(`${line}\n`, "A");
        expect(message).toMatch(/^A in \.env uses /);
        expect(message).not.toContain("t0psecret");
        expect(message.split("\n")).toHaveLength(2);
      }
    });

    test("restore.sh asks for nothing more once the reader stops", () => {
      expect(script).toContain('value=$(from_env_file "$1") || exit 1');
    });
  });

  test("it never runs the file", async () => {
    expect(await readValue("A=$(echo ran)\nB=`echo ran`\n", "A")).toBe("$(echo ran)");
    expect(await readValue("B=`echo ran`\nA=${B}\n", "A")).toBe("`echo ran`");
    expect(reader).not.toMatch(/\beval\b|^\s*\.\s|\bsource\b/m);
  });
});
