import { promises as dns } from "node:dns";
import { BlockList, isIP } from "node:net";

/**
 * Protect uptime checks and webhooks from reaching internal services (docs/uptime-alerts.md,
 * "Requests a check must not make"). Reject the host if any resolved address is refused. Pin
 * the connection to a checked address without resolving again (request.ts).
 */

/** What kind of address one is, when checks may not reach it; null for a public address. */
export type AddressKind =
  | "loopback"
  | "private"
  | "link-local"
  | "unique-local"
  | "shared"
  | "multicast"
  | "unspecified"
  | "reserved"
  | "metadata"
  | "denied";

/**
 * UPTIME_ALLOW_PRIVATE_ADDRESSES permits checks on the instance's network. Always refuse
 * link-local addresses, including metadata at 169.254.169.254.
 */
const PRIVATE_KINDS: ReadonlySet<AddressKind> = new Set([
  "loopback",
  "private",
  "unique-local",
  "shared",
]);

const IPV4_RANGES: [AddressKind, string, number][] = [
  ["unspecified", "0.0.0.0", 8],
  ["private", "10.0.0.0", 8],
  ["shared", "100.64.0.0", 10],
  ["loopback", "127.0.0.0", 8],
  ["link-local", "169.254.0.0", 16],
  ["private", "172.16.0.0", 12],
  // IETF protocol assignments, documentation, the old 6to4 relay, benchmarking.
  ["reserved", "192.0.0.0", 24],
  ["reserved", "192.0.2.0", 24],
  ["reserved", "192.88.99.0", 24],
  ["private", "192.168.0.0", 16],
  ["reserved", "198.18.0.0", 15],
  ["reserved", "198.51.100.0", 24],
  ["reserved", "203.0.113.0", 24],
  ["multicast", "224.0.0.0", 4],
  // Reserved for future use, and the broadcast address 255.255.255.255.
  ["reserved", "240.0.0.0", 4],
];

/**
 * IPv6 ranges, checked after the forms that hold an IPv4 address (mapped,
 * NAT64, 6to4) have been read as that address. Anything outside the
 * global unicast block 2000::/3 that is not named here is reserved.
 */
const IPV6_RANGES: [AddressKind, string, number][] = [
  ["unspecified", "::", 128],
  ["loopback", "::1", 128],
  // Local-use NAT64 (RFC 8215): addresses of the operator's own network.
  ["private", "64:ff9b:1::", 48],
  ["unique-local", "fc00::", 7],
  ["link-local", "fe80::", 10],
  ["multicast", "ff00::", 8],
  // IETF protocol assignments (Teredo among them), documentation.
  ["reserved", "2001::", 23],
  ["reserved", "2001:db8::", 32],
  ["reserved", "3fff::", 20],
];

function blockListOf(kind: AddressKind, family: "ipv4" | "ipv6"): BlockList {
  const list = new BlockList();
  for (const [rangeKind, network, prefix] of family === "ipv4" ? IPV4_RANGES : IPV6_RANGES) {
    if (rangeKind === kind) list.addSubnet(network, prefix, family);
  }
  return list;
}

const KINDS: AddressKind[] = [
  "unspecified",
  "loopback",
  "private",
  "shared",
  "link-local",
  "unique-local",
  "multicast",
  "reserved",
];
const IPV4_LISTS = KINDS.map((kind) => [kind, blockListOf(kind, "ipv4")] as const);
const IPV6_LISTS = KINDS.map((kind) => [kind, blockListOf(kind, "ipv6")] as const);
const GLOBAL_UNICAST = new BlockList();
GLOBAL_UNICAST.addSubnet("2000::", 3, "ipv6");

const groupsOf = (part: string) => (part === "" ? [] : part.split(":"));

/** Requires a valid IPv6 address (isIP 6). */
export function ipv6Bytes(address: string): number[] {
  let text = address;
  const bytes: number[] = [];
  // A dotted IPv4 address at the end stands for the last 32 bits.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  let tail: number[] = [];
  if (dotted?.[1] !== undefined) {
    tail = dotted[1].split(".").map(Number);
    text = `${text.slice(0, dotted.index)}0:0`;
  }
  const [head = "", rest] = text.split("::");
  const left = groupsOf(head);
  const right = rest === undefined ? [] : groupsOf(rest);
  const missing = 8 - left.length - right.length;
  const groups = [...left, ...Array<string>(rest === undefined ? 0 : missing).fill("0"), ...right];
  for (const group of groups) {
    const value = Number.parseInt(group, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes;
}

/**
 * The IPv4 address an IPv6 address carries, if it is one of the forms
 * that reach an IPv4 address: IPv4-mapped (::ffff:a.b.c.d), NAT64's
 * well-known prefix (64:ff9b::/96), and 6to4 (2002:aabb:ccdd::/16).
 */
export function embeddedIpv4(address: string): string | null {
  const bytes = ipv6Bytes(address);
  const zeros = (from: number, to: number) => bytes.slice(from, to).every((byte) => byte === 0);
  const quad = (at: number) => bytes.slice(at, at + 4).join(".");
  if (zeros(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return quad(12);
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    if (zeros(4, 12)) return quad(12);
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return quad(2);
  return null;
}

function bare(address: string): string {
  const unbracketed =
    address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  const zone = unbracketed.indexOf("%");
  return zone === -1 ? unbracketed : unbracketed.slice(0, zone);
}

/** What kind of address `address` is, if checks may not reach it; null for a public one. */
export function addressKind(address: string): AddressKind | null {
  const ip = bare(address);
  const version = isIP(ip);
  if (version === 4) {
    return IPV4_LISTS.find(([, list]) => list.check(ip, "ipv4"))?.[0] ?? null;
  }
  if (version !== 6) return "reserved";
  const inner = embeddedIpv4(ip);
  if (inner !== null) return addressKind(inner);
  const named = IPV6_LISTS.find(([, list]) => list.check(ip, "ipv6"))?.[0];
  if (named !== undefined) return named;
  return GLOBAL_UNICAST.check(ip, "ipv6") ? null : "reserved";
}

/**
 * Cloud metadata services, refused whatever the settings say: they hand
 * out an instance's credentials. Most answer at 169.254.169.254, which is
 * link-local and refused anyway (AWS, Google Cloud, Azure, Oracle Cloud,
 * DigitalOcean, Hetzner); these are the ones outside link-local, which
 * UPTIME_ALLOW_PRIVATE_ADDRESSES would otherwise let through:
 *
 * - 100.100.100.200: Alibaba Cloud (a shared, CGNAT, address).
 * - fd00:ec2::254: AWS's IPv6 endpoint (unique-local).
 * - fd20:ce::254: Google Cloud's, on IPv6-only instances (unique-local).
 * - fd00:c1::a9fe:a9fe: Oracle Cloud's IPv6 endpoint, as cloud-init reads it.
 * - 168.63.129.16: Azure's host endpoint (WireServer), which serves a VM's
 *   configuration and certificates; a public address, refused everywhere.
 */
export const METADATA_ADDRESSES = [
  "169.254.169.254",
  "100.100.100.200",
  "168.63.129.16",
  "fd00:ec2::254",
  "fd20:ce::254",
  "fd00:c1::a9fe:a9fe",
] as const;

const METADATA = new BlockList();
for (const address of METADATA_ADDRESSES) {
  METADATA.addAddress(address, isIP(address) === 6 ? "ipv6" : "ipv4");
}

const familyOf = (ip: string) => (isIP(ip) === 6 ? "ipv6" : "ipv4");

export interface AddressPolicy {
  /** UPTIME_ALLOW_PRIVATE_ADDRESSES: loopback, private, unique-local, and shared addresses allowed. */
  allowPrivate: boolean;
  /** UPTIME_DENY_ADDRESSES: addresses and ranges always refused, such as the server's own public address. */
  deny?: BlockList | undefined;
}

/** An address, or a range in CIDR notation, as UPTIME_DENY_ADDRESSES lists them; null when it is not one. */
export function parseAddressRange(
  entry: string,
): { address: string; prefix: number | null; family: "ipv4" | "ipv6" } | null {
  const [address = "", prefix, extra] = entry.trim().split("/");
  const version = isIP(address);
  if (version === 0 || extra !== undefined) return null;
  if (prefix === undefined) return { address, prefix: null, family: familyOf(address) };
  const bits = Number(prefix);
  if (!/^\d+$/.test(prefix) || bits > (version === 6 ? 128 : 32)) return null;
  return { address, prefix: bits, family: familyOf(address) };
}

/** The rules' settings from the configuration; throws on an entry that is not an address or range. */
export function addressPolicy({
  allowPrivate,
  deny = [],
}: {
  allowPrivate: boolean;
  deny?: readonly string[];
}): AddressPolicy {
  if (deny.length === 0) return { allowPrivate };
  const list = new BlockList();
  for (const entry of deny) {
    const range = parseAddressRange(entry);
    if (range === null) throw new Error(`Not an address or CIDR range: "${entry}"`);
    if (range.prefix === null) list.addAddress(range.address, range.family);
    else list.addSubnet(range.address, range.prefix, range.family);
  }
  return { allowPrivate, deny: list };
}

/** Why an address may not be reached; null when it may. */
export function refusedKind(address: string, policy: AddressPolicy): AddressKind | null {
  const ip = bare(address);
  const inner = isIP(ip) === 6 ? embeddedIpv4(ip) : null;
  const forms = inner === null ? [ip] : [ip, inner];
  if (forms.some((form) => isIP(form) !== 0 && METADATA.check(form, familyOf(form)))) {
    return "metadata";
  }
  const { deny } = policy;
  if (
    deny !== undefined &&
    forms.some((form) => isIP(form) !== 0 && deny.check(form, familyOf(form)))
  ) {
    return "denied";
  }
  const kind = addressKind(ip);
  if (kind === null) return null;
  return policy.allowPrivate && PRIVATE_KINDS.has(kind) ? null : kind;
}

const KIND_TEXT: Record<AddressKind, string> = {
  loopback: "a loopback address",
  private: "a private address",
  "link-local": "a link-local address",
  "unique-local": "a unique-local address",
  shared: "a shared (CGNAT) address",
  multicast: "a multicast address",
  unspecified: "the unspecified address",
  reserved: "a reserved address",
  metadata: "a cloud metadata service's address",
  denied: "an address this instance refuses",
};

export type Requester = "checks" | "webhooks" | "backups" | "favicons";

/**
 * Hide resolved addresses and their kinds from users to prevent discovery of internal services.
 * Keep both for server logs. Literal IPs may be named because the user supplied them.
 */
export class AddressNotAllowedError extends Error {
  override name = "AddressNotAllowedError";
  readonly host: string;
  readonly address: string;
  readonly kind: AddressKind;
  constructor(host: string, address: string, kind: AddressKind, who: Requester = "checks") {
    const literal = isIP(host) !== 0;
    const inner = literal && isIP(host) === 6 ? embeddedIpv4(host) : null;
    const what = inner === null ? KIND_TEXT[kind] : `${inner}, ${KIND_TEXT[kind]}`;
    super(
      literal
        ? `${host} is ${inner === null ? "" : "an IPv6 form of "}${what}: ${who} may not reach it.`
        : `${host} resolves to an address ${who} may not reach.`,
    );
    this.host = host;
    this.address = address;
    this.kind = kind;
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * Resolves a host name to all its addresses; ends when `signal` fires.
 * Tests pass a fake.
 */
export type Lookup = (hostname: string, signal?: AbortSignal) => Promise<ResolvedAddress[]>;

/**
 * Use cancellable c-ares queries to avoid blocking libuv's four getaddrinfo threads and
 * delaying other checks or database connections. Query system name servers (/etc/resolv.conf);
 * /etc/hosts is ignored, including localhost entries. Prefer IPv4 when available.
 */
export function resolverLookup({
  servers,
  timeoutMs = 2000,
  tries = 2,
}: { servers?: string[]; timeoutMs?: number; tries?: number } = {}): Lookup {
  return async (hostname, signal) => {
    const resolver = new dns.Resolver({ timeout: timeoutMs, tries });
    if (servers !== undefined) resolver.setServers(servers);
    const cancel = () => resolver.cancel();
    if (signal?.aborted === true) throw signal.reason;
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const [v4, v6] = await Promise.allSettled([
        resolver.resolve4(hostname),
        resolver.resolve6(hostname),
      ]);
      const addresses: ResolvedAddress[] = [
        ...(v4.status === "fulfilled"
          ? v4.value.map((address) => ({ address, family: 4 as const }))
          : []),
        ...(v6.status === "fulfilled"
          ? v6.value.map((address) => ({ address, family: 6 as const }))
          : []),
      ];
      if (addresses.length > 0) return addresses;
      // Prefer a DNS failure reason over ENODATA.
      const reasons = [v4, v6].flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      const telling = reasons.find((reason) => codeOf(reason) !== "ENODATA") ?? reasons[0];
      if (telling !== undefined) throw telling;
      return [];
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  };
}

const codeOf = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? error.code : undefined;

export const systemLookup: Lookup = resolverLookup();

export class NoAddressError extends Error {
  override name = "NoAddressError";
  readonly code = "ENOTFOUND";
}

/**
 * Check every resolved address before returning the first. Literal IPs skip DNS. Throw
 * AddressNotAllowedError for refused addresses, or the DNS error (NoAddressError when empty).
 */
export async function resolveTarget(
  url: URL,
  {
    lookup,
    policy,
    signal,
    who = "checks",
  }: { lookup: Lookup; policy: AddressPolicy; signal?: AbortSignal; who?: Requester },
): Promise<ResolvedAddress> {
  const host = bare(url.hostname);
  const literal = isIP(host);
  const addresses: ResolvedAddress[] =
    literal === 0 ? await lookup(host, signal) : [{ address: host, family: literal === 6 ? 6 : 4 }];
  if (addresses.length === 0) throw new NoAddressError(`${host} has no address.`);
  for (const entry of addresses) {
    const kind = refusedKind(entry.address, policy);
    if (kind !== null) throw new AddressNotAllowedError(host, bare(entry.address), kind, who);
  }
  const [first] = addresses;
  if (first === undefined) throw new NoAddressError(`${host} has no address.`);
  return { address: bare(first.address), family: first.family };
}
