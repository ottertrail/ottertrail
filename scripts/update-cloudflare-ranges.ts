/**
 * Refreshes Cloudflare's address ranges in deploy/compose.yaml (the
 * caddy-proxy-cloudflare config, and its hash label on the caddy service)
 * from https://www.cloudflare.com/ips-v4 and ips-v6. Caddy trusts
 * CF-Connecting-IP only from these ranges, and deploy/cloudflare-firewall.sh
 * reads them from the same file (docs/deployment.md, "Behind Cloudflare's
 * proxy"). Installs get them with each release's compose.yaml.
 *
 *   node scripts/update-cloudflare-ranges.ts
 *
 * Every line must be one CIDR range of its family, without repeats, and a
 * result with fewer than 5 IPv4 or 3 IPv6 ranges is refused as implausible.
 *
 * Exit codes, for the weekly workflow (.github/workflows/cloudflare-ranges.yml):
 *   0  the ranges changed and compose.yaml was rewritten;
 *   2  no range changed, and the file was left as it was;
 *   1  failed: the download or its checks; the file was left as it was.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isIPv4, isIPv6 } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const SOURCES = {
  v4: "https://www.cloudflare.com/ips-v4",
  v6: "https://www.cloudflare.com/ips-v6",
} as const;

export const CONFIG_NAME = "caddy-proxy-cloudflare";

// Fewer would mean a truncated or wrong download; more would be a different list.
const LIMITS = { v4: { min: 5, max: 100 }, v6: { min: 3, max: 100 } } as const;
// Shorter prefixes would trust a large part of the internet.
const SHORTEST_PREFIX = { v4: 8, v6: 16 } as const;
const TIMEOUT_MS = 30_000;

export type Family = "v4" | "v6";

/** One range, or the reason it is not one of `family`. */
export function checkRange(text: string, family: Family): string | null {
  const match = /^([0-9a-f.:]+)\/(\d{1,3})$/.exec(text);
  if (match === null) return `not a CIDR range: ${JSON.stringify(text.slice(0, 60))}`;
  const [, address = "", prefixText = ""] = match;
  const valid = family === "v4" ? isIPv4(address) : isIPv6(address);
  if (!valid) return `not an IP${family} address: ${text}`;
  const prefix = Number(prefixText);
  const longest = family === "v4" ? 32 : 128;
  if (prefix < SHORTEST_PREFIX[family] || prefix > longest) {
    return `prefix out of range (${SHORTEST_PREFIX[family]} to ${longest}): ${text}`;
  }
  return null;
}

/** Cloudflare's list, one range per line, checked; throws on anything else. */
export function parseRanges(text: string, family: Family): string[] {
  const ranges = text
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line !== "");
  for (const range of ranges) {
    const problem = checkRange(range, family);
    if (problem !== null) throw new Error(`IP${family} list: ${problem}`);
  }
  if (new Set(ranges).size !== ranges.length) throw new Error(`IP${family} list: repeated range`);
  const { min, max } = LIMITS[family];
  if (ranges.length < min || ranges.length > max) {
    throw new Error(`IP${family} list: ${ranges.length} ranges, expected ${min} to ${max}`);
  }
  return ranges;
}

const RANGES_LINE = /^( {6}\ttrusted_proxies static )(.*)$/m;

/** A config's inline content, read as apps/api/tests/deploy-files.test.ts reads it. */
export function inlineConfig(compose: string, name: string): string {
  const lines = compose.split("\n");
  const top = lines.indexOf("configs:");
  const start = lines.indexOf(`  ${name}:`, top);
  if (top === -1 || start === -1 || lines[start + 1] !== "    content: |") {
    throw new Error(`compose.yaml has no inline config ${name}`);
  }
  const body: string[] = [];
  for (const line of lines.slice(start + 2)) {
    if (line !== "" && !line.startsWith("      ")) break;
    body.push(line.slice(6));
  }
  return `${body.join("\n").trimEnd()}\n`;
}

/** The ranges compose.yaml ships, in its order. */
export function shippedRanges(compose: string): string[] {
  const line = /^\ttrusted_proxies static (.*)$/m.exec(inlineConfig(compose, CONFIG_NAME));
  if (line === null) throw new Error(`${CONFIG_NAME} has no trusted_proxies line`);
  return (line[1] ?? "").split(" ");
}

/** compose.yaml with `ranges` in the config, and the config's new hash in its label. */
export function rewriteCompose(compose: string, ranges: string[]): string {
  const configStart = compose.indexOf(`\n  ${CONFIG_NAME}:\n    content: |\n`);
  if (configStart === -1) throw new Error(`compose.yaml has no inline config ${CONFIG_NAME}`);
  const before = compose.slice(0, configStart);
  const after = compose.slice(configStart);
  if (!RANGES_LINE.test(after)) throw new Error(`${CONFIG_NAME} has no trusted_proxies line`);
  const updated = before + after.replace(RANGES_LINE, (_, head: string) => head + ranges.join(" "));
  const hash = createHash("sha256")
    .update(inlineConfig(updated, CONFIG_NAME))
    .digest("hex")
    .slice(0, 12);
  const label = new RegExp(`^( {6}ottertrail\\.config\\.${CONFIG_NAME}: )".*"$`, "m");
  if (!label.test(updated)) throw new Error(`compose.yaml has no label for ${CONFIG_NAME}`);
  return updated.replace(label, (_, head: string) => `${head}"${hash}"`);
}

async function download(url: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "user-agent": "ottertrail-cloudflare-ranges-update" },
  });
  if (!response.ok) throw new Error(`${response.status} from ${url}`);
  return response.text();
}

async function main(): Promise<number> {
  const file = join(import.meta.dirname, "../deploy/compose.yaml");
  const v4 = parseRanges(await download(SOURCES.v4), "v4");
  const v6 = parseRanges(await download(SOURCES.v6), "v6");
  const ranges = [...v4, ...v6];
  const compose = await readFile(file, "utf8");
  const shipped = shippedRanges(compose);
  const added = ranges.filter((range) => !shipped.includes(range));
  const removed = shipped.filter((range) => !ranges.includes(range));
  console.log(`Cloudflare: ${v4.length} IPv4 and ${v6.length} IPv6 ranges`);
  console.log(`Added ${added.length}${added.length > 0 ? `: ${added.join(", ")}` : ""}`);
  console.log(`Removed ${removed.length}${removed.length > 0 ? `: ${removed.join(", ")}` : ""}`);
  if (added.length === 0 && removed.length === 0) {
    console.log("No range changed: compose.yaml stays as it is.");
    return UNCHANGED;
  }
  await writeFile(file, rewriteCompose(compose, ranges));
  console.log(`Wrote ${ranges.length} ranges to ${file}`);
  return CHANGED;
}

const CHANGED = 0;
const UNCHANGED = 2;
const FAILED = 1;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = FAILED;
  }
}
