import { BlockList, isIP } from "node:net";

import { ipv6Bytes } from "../outbound/addresses.ts";

/** Matches the projects table's check (migration 0008_spam_rules). */
export const MAX_BLOCKED_ADDRESSES = 100;

/**
 * Reject ranges wider than /8 IPv4 or /16 IPv6 to limit damage from mistyped
 * prefixes. Blocked events are acknowledged, so the mistake would be silent.
 */
export const MIN_PREFIX = { ipv4: 8, ipv6: 16 } as const;

type Family = "ipv4" | "ipv6";

interface Entry {
  family: Family;
  /** The address, or the range's network address, in its canonical form. */
  address: string;
  /** The prefix length; the family's full width for one address. */
  prefix: number;
}

const WIDTH = { ipv4: 32, ipv6: 128 } as const;

function ipv4Value(address: string): bigint {
  return address.split(".").reduce((value, part) => (value << 8n) | BigInt(Number(part)), 0n);
}

function ipv4Text(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join(".");
}

function ipv6Value(address: string): bigint {
  return ipv6Bytes(address).reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
}

/** An IPv6 address in its shortest form, lower case: as URL writes it. */
function ipv6Text(value: bigint): string {
  const groups = Array.from({ length: 8 }, (_, index) =>
    ((value >> BigInt((7 - index) * 16)) & 0xffffn).toString(16),
  );
  return new URL(`http://[${groups.join(":")}]`).hostname.slice(1, -1);
}

/** The IPv4 address an IPv4-mapped IPv6 address (::ffff:a.b.c.d) stands for, or null. */
function mappedIpv4(value: bigint): bigint | null {
  return value >> 32n === 0xffffn ? value & 0xffff_ffffn : null;
}

/**
 * One entry of the list, checked and in its canonical form, or a reason it
 * is refused:
 * - an IPv4 or IPv6 address, or a CIDR range of either (203.0.113.0/24);
 * - an IPv4-mapped IPv6 address (::ffff:203.0.113.7) becomes its IPv4
 *   address, as clientKey() counts it, so the list holds each address once;
 * - a range becomes its network address (10.1.2.3/8 is 10.0.0.0/8), and a
 *   range of one address the address (203.0.113.7/32 is 203.0.113.7);
 * - IPv6 in its shortest form, lower case;
 * - no zone (fe80::1%eth0), no ranges wider than MIN_PREFIX.
 */
export function parseBlockedAddress(raw: string): { ok: true; entry: Entry } | { ok: false } {
  const text = raw.trim();
  const slash = text.indexOf("/");
  const addressText = slash === -1 ? text : text.slice(0, slash);
  const prefixText = slash === -1 ? undefined : text.slice(slash + 1);
  const version = addressText.includes("%") ? 0 : isIP(addressText);
  if (version === 0 || (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText))) {
    return { ok: false };
  }
  let family: Family = version === 4 ? "ipv4" : "ipv6";
  let value = family === "ipv4" ? ipv4Value(addressText) : ipv6Value(addressText);
  let prefix = prefixText === undefined ? WIDTH[family] : Number(prefixText);
  if (prefix > WIDTH[family]) return { ok: false };
  if (family === "ipv6") {
    const mapped = mappedIpv4(value);
    if (mapped !== null) {
      // A mapped range narrower than the IPv4 space is an IPv4 range.
      if (prefix < 96) return { ok: false };
      family = "ipv4";
      value = mapped;
      prefix -= 96;
    }
  }
  if (prefix < MIN_PREFIX[family]) return { ok: false };
  const host = (1n << BigInt(WIDTH[family] - prefix)) - 1n;
  const network = value & ~host;
  return {
    ok: true,
    entry: { family, address: family === "ipv4" ? ipv4Text(network) : ipv6Text(network), prefix },
  };
}

function entryText(entry: Entry): string {
  return entry.prefix === WIDTH[entry.family] ? entry.address : `${entry.address}/${entry.prefix}`;
}

export type BlockedAddressesResult =
  | { ok: true; addresses: string[] }
  | { ok: false; message: string };

/**
 * Returns canonical entries without duplicates or the first invalid entry.
 * Keep validation aligned with apps/web/src/features/projects/blocked-addresses.ts.
 */
export function parseBlockedAddresses(raw: readonly string[]): BlockedAddressesResult {
  const addresses: string[] = [];
  for (const line of raw) {
    const parsed = parseBlockedAddress(line);
    if (!parsed.ok) {
      return {
        ok: false,
        message: `"${line.slice(0, 100)}" is not an IP address or range. Enter an IPv4 or IPv6 address, such as 203.0.113.7, or a range, such as 203.0.113.0/24 (at most a /${MIN_PREFIX.ipv4} for IPv4, a /${MIN_PREFIX.ipv6} for IPv6).`,
      };
    }
    const text = entryText(parsed.entry);
    if (!addresses.includes(text)) addresses.push(text);
  }
  if (addresses.length > MAX_BLOCKED_ADDRESSES) {
    return {
      ok: false,
      message: `A project blocks at most ${MAX_BLOCKED_ADDRESSES} addresses and ranges.`,
    };
  }
  return { ok: true, addresses };
}

/**
 * Built once per cached project (collection/project-keys.ts); null for no entries.
 * Skip stored entries that no longer parse, such as manually edited values.
 */
export function blockListOf(addresses: readonly string[]): BlockList | null {
  let list: BlockList | null = null;
  for (const text of addresses) {
    const parsed = parseBlockedAddress(text);
    if (!parsed.ok) continue;
    list ??= new BlockList();
    const { family, address, prefix } = parsed.entry;
    if (prefix === WIDTH[family]) list.addAddress(address, family);
    else list.addSubnet(address, prefix, family);
  }
  return list;
}

/**
 * Whether a client's address is on the list. An IPv4-mapped address, as
 * a dual-stack server sees IPv4 clients, is checked as its IPv4 address.
 */
export function isBlockedAddress(list: BlockList | null, ip: string): boolean {
  if (list === null) return false;
  const version = isIP(ip);
  if (version === 4) return list.check(ip, "ipv4");
  if (version !== 6) return false;
  const mapped = mappedIpv4(ipv6Value(ip));
  return mapped === null ? list.check(ip, "ipv6") : list.check(ipv4Text(mapped), "ipv4");
}

/**
 * The address a request came from, as the API sees it (TRUST_PROXY applies),
 * for the dashboard's "Add my address": an IPv4-mapped address as IPv4, and
 * for IPv6 also its /64, the block one household or office usually holds,
 * whose other addresses the same browser may use tomorrow.
 */
export function ownAddress(ip: string): { address: string; network: string | null } {
  const parsed = parseBlockedAddress(ip);
  if (!parsed.ok) return { address: ip, network: null };
  const { entry } = parsed;
  if (entry.family === "ipv4") return { address: entry.address, network: null };
  const network = parseBlockedAddress(`${entry.address}/64`);
  return {
    address: entry.address,
    network: network.ok ? entryText(network.entry) : null,
  };
}
