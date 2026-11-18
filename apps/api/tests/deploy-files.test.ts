import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

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

  test("it mounts no file from beside it", () => {
    expect(compose).not.toMatch(/^\s*- \.{1,2}\//m);
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
