import { readFile } from "node:fs/promises";
import { BlockList, isIPv4, isIPv6 } from "node:net";

/**
 * Address ranges of cloud and hosting providers. People browse from homes,
 * offices, and phones; a "browser" in a data center is almost always a
 * program: a scraper, a headless browser, a test run. Collection ignores
 * its events, as it does bots that say what they are
 * (docs/web-analytics.md, "Data centers").
 *
 * `vp run geo:update` downloads the ranges (data-center-sources.ts) into
 * one JSON file; the API reads it at startup.
 */
export interface DataCenterFile {
  version: 1;
  /** When the file was written. */
  updatedAt: string;
  providers: DataCenterProvider[];
}

export interface DataCenterProvider {
  /** Stable ID, such as "aws". */
  id: string;
  /** For people, such as "Amazon Web Services (EC2)". */
  name: string;
  /** Where the ranges came from. */
  source: string;
  /** When they were downloaded: older than the file's when a later download failed. */
  fetchedAt: string;
  /** "203.0.113.0/24", "2001:db8::/32", or "203.0.113.5-203.0.113.9". */
  ranges: string[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether an IP address belongs to a data center. */
export type IsDataCenter = (ip: string) => boolean;

/** No ranges loaded: nothing counts as a data center. */
export const noDataCenters: IsDataCenter = () => false;

type Family = "ipv4" | "ipv6";

function familyOf(address: string): Family | null {
  if (isIPv4(address)) return "ipv4";
  if (isIPv6(address)) return "ipv6";
  return null;
}

/** "::ffff:203.0.113.5", an IPv4 address on an IPv6 socket, as "203.0.113.5". */
function unmapped(ip: string): string {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return match?.[1] ?? ip;
}

/** An address as a number: 32 bits for IPv4, 128 for IPv6. Null when it is not one. */
export function addressValue(address: string): { family: Family; value: bigint } | null {
  if (isIPv4(address)) {
    const value = address
      .split(".")
      .reduce((total, part) => (total << 8n) | BigInt(Number(part)), 0n);
    return { family: "ipv4", value };
  }
  if (!isIPv6(address) || address.includes("%")) return null;
  // An IPv4 tail, as in "::ffff:192.0.2.1", is two groups.
  let text = address.toLowerCase();
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail?.[1] !== undefined) {
    const v4 = addressValue(tail[1]);
    if (v4 === null) return null;
    const high = Number(v4.value >> 16n).toString(16);
    const low = Number(v4.value & 0xffffn).toString(16);
    text = `${text.slice(0, -tail[1].length)}${high}:${low}`;
  }
  const [head = "", rest] = text.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = rest === undefined || rest === "" ? [] : rest.split(":");
  const missing = 8 - left.length - right.length;
  const groups =
    rest === undefined ? left : [...left, ...Array<string>(missing).fill("0"), ...right];
  if (groups.length !== 8) return null;
  const value = groups.reduce((total, group) => (total << 16n) | BigInt(`0x${group}`), 0n);
  return { family: "ipv6", value };
}

const v4 = (text: string) => addressValue(text)?.value ?? 0n;
const v6 = (text: string) => addressValue(text)?.value ?? 0n;

/**
 * Where no cloud server's public address can be: private, loopback,
 * link-local, shared (carrier-grade NAT), multicast, and reserved IPv4.
 * A range over any of them is a mistake, and could make the API's own
 * proxy, or every local test, count as a data center.
 */
const RESERVED_IPV4: [bigint, bigint][] = [
  ["0.0.0.0", "0.255.255.255"],
  ["10.0.0.0", "10.255.255.255"],
  ["100.64.0.0", "100.127.255.255"],
  ["127.0.0.0", "127.255.255.255"],
  ["169.254.0.0", "169.254.255.255"],
  ["172.16.0.0", "172.31.255.255"],
  ["192.168.0.0", "192.168.255.255"],
  ["224.0.0.0", "255.255.255.255"],
].map(([from, to]) => [v4(from!), v4(to!)]);

/** Global unicast IPv6 (2000::/3), without 6to4 (2002::/16), whose addresses stand for IPv4 ones. */
const GLOBAL_IPV6: [bigint, bigint] = [v6("2000::"), v6("3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff")];
const SIX_TO_FOUR: [bigint, bigint] = [v6("2002::"), v6("2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff")];

/** At most a /8 of IPv4 or a /16 of IPv6: anything wider is not one provider's. */
const MAX_SIZE = { ipv4: 1n << 24n, ipv6: 1n << 112n };

const overlaps = (start: bigint, end: bigint, [from, to]: [bigint, bigint]) =>
  start <= to && end >= from;

/**
 * A range's first and last address. Null when it is not a well-formed
 * CIDR block, single address, or start-end range of one family, or when it
 * is too wide, or covers addresses no cloud server has.
 */
export function parseRange(range: string): {
  family: Family;
  start: bigint;
  end: bigint;
  /** The first and last address as written. */
  text: [string, string];
  /** For a CIDR block: its prefix length. */
  prefix?: number;
} | null {
  let startText: string;
  let endText: string | undefined;
  let bits: number | undefined;
  const dash = range.indexOf("-");
  const slash = range.indexOf("/");
  if (dash !== -1) {
    startText = range.slice(0, dash).trim();
    endText = range.slice(dash + 1).trim();
  } else if (slash !== -1) {
    startText = range.slice(0, slash).trim();
    const bitsText = range.slice(slash + 1).trim();
    if (!/^\d{1,3}$/.test(bitsText)) return null;
    bits = Number(bitsText);
  } else {
    startText = range.trim();
  }
  const first = addressValue(startText);
  if (first === null) return null;
  const width = first.family === "ipv4" ? 32 : 128;
  let start = first.value;
  let end = first.value;
  if (endText !== undefined) {
    const last = addressValue(endText);
    if (last === null || last.family !== first.family || last.value < start) return null;
    end = last.value;
    endText = endText.trim();
  } else if (bits !== undefined) {
    if (bits > width) return null;
    const host = (1n << BigInt(width - bits)) - 1n;
    start = first.value & ~host;
    end = start | host;
  }
  if (end - start + 1n > MAX_SIZE[first.family]) return null;
  if (first.family === "ipv4") {
    if (RESERVED_IPV4.some((reserved) => overlaps(start, end, reserved))) return null;
  } else if (start < GLOBAL_IPV6[0] || end > GLOBAL_IPV6[1] || overlaps(start, end, SIX_TO_FOUR)) {
    return null;
  }
  return {
    family: first.family,
    start,
    end,
    text: [startText, endText ?? startText],
    ...(bits === undefined ? {} : { prefix: bits }),
  };
}

/** The ranges parseRange accepts, in their order. */
export function validRanges(ranges: string[]): string[] {
  return ranges.filter((range) => parseRange(range) !== null);
}

/**
 * The ranges, held in memory as Node.js's BlockList: a few microseconds a
 * lookup with the 20,000 ranges of November 2026.
 */
export class DataCenters {
  readonly #list: BlockList;
  readonly updatedAt: Date;
  readonly providers: { id: string; name: string; fetchedAt: Date; ranges: number }[];
  /** Ranges in the file that were not well formed, and so not used. */
  readonly skipped: number;

  private constructor(
    list: BlockList,
    updatedAt: Date,
    providers: DataCenters["providers"],
    skipped: number,
  ) {
    this.#list = list;
    this.updatedAt = updatedAt;
    this.providers = providers;
    this.skipped = skipped;
  }

  /** Reads a file written by the update script. Throws when it is missing or not one. */
  static async open(path: string): Promise<DataCenters> {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return DataCenters.from(parsed);
  }

  static from(file: unknown): DataCenters {
    if (!isDataCenterFile(file)) {
      throw new Error("not a data-center file (version 1)");
    }
    const list = new BlockList();
    let skipped = 0;
    const providers = file.providers.map((provider) => {
      let added = 0;
      for (const range of provider.ranges) {
        const parsed = parseRange(range);
        if (parsed === null) {
          skipped += 1;
          continue;
        }
        if (parsed.prefix === undefined) {
          list.addRange(parsed.text[0], parsed.text[1], parsed.family);
        } else {
          list.addSubnet(parsed.text[0], parsed.prefix, parsed.family);
        }
        added += 1;
      }
      return {
        id: provider.id,
        name: provider.name,
        fetchedAt: new Date(provider.fetchedAt),
        ranges: added,
      };
    });
    return new DataCenters(list, new Date(file.updatedAt), providers, skipped);
  }

  /** Whether the address is in any provider's ranges. Never throws. */
  has(ip: string): boolean {
    const address = unmapped(ip.trim());
    const family = familyOf(address);
    return family !== null && this.#list.check(address, family);
  }
}

/** Whether a parsed JSON value has the shape of a file the update script writes. */
export function isDataCenterFile(value: unknown): value is DataCenterFile {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.updatedAt === "string" &&
    !Number.isNaN(Date.parse(value.updatedAt)) &&
    Array.isArray(value.providers) &&
    value.providers.every(
      (provider: unknown) =>
        isRecord(provider) &&
        typeof provider.id === "string" &&
        typeof provider.name === "string" &&
        typeof provider.source === "string" &&
        typeof provider.fetchedAt === "string" &&
        !Number.isNaN(Date.parse(provider.fetchedAt)) &&
        Array.isArray(provider.ranges) &&
        provider.ranges.every((range) => typeof range === "string"),
    )
  );
}
