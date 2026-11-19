/**
 * The rules of a project's blocked addresses and blocked referrers, as the
 * API checks them (apps/api/src/projects/blocked-addresses.ts and
 * blocked-referrers.ts), so the Spam and bots tab can say what is wrong
 * before saving. The API checks again and stores the normal forms.
 */

export const MAX_BLOCKED_ADDRESSES = 100;
export const MAX_BLOCKED_REFERRERS = 100;
/** The widest range an entry may be, as the API allows. */
export const MIN_PREFIX = { ipv4: 8, ipv6: 16 } as const;

const WIDTH = { ipv4: 32, ipv6: 128 } as const;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}$/;

/** The non-empty lines of a text box, trimmed. */
export function linesOf(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function ipv4Value(address: string): bigint {
  return address.split(".").reduce((value, part) => (value << 8n) | BigInt(Number(part)), 0n);
}

function ipv4Text(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join(".");
}

/** An IPv6 address's value, or null when it is not one. The URL parser checks and expands it. */
function ipv6Value(address: string): bigint | null {
  if (!address.includes(":") || /[%[\]/]/.test(address)) return null;
  const url = URL.parse(`http://[${address}]/`);
  if (url === null) return null;
  const host = url.hostname.slice(1, -1);
  const [head = "", tail] = host.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const groups = [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  return groups.reduce((value, group) => (value << 16n) | BigInt(Number.parseInt(group, 16)), 0n);
}

function ipv6Text(value: bigint): string {
  const groups = Array.from({ length: 8 }, (_, index) =>
    ((value >> BigInt((7 - index) * 16)) & 0xffffn).toString(16),
  );
  return new URL(`http://[${groups.join(":")}]/`).hostname.slice(1, -1);
}

/**
 * One blocked address or range in the form the API stores it, or null when
 * the API would refuse it: IPv4-mapped IPv6 as IPv4, a range as its
 * network address, one address without its /32 or /128.
 */
export function normalAddress(raw: string): string | null {
  const text = raw.trim();
  const slash = text.indexOf("/");
  const addressText = slash === -1 ? text : text.slice(0, slash);
  const prefixText = slash === -1 ? undefined : text.slice(slash + 1);
  if (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText)) return null;
  let family: "ipv4" | "ipv6";
  let value: bigint;
  if (IPV4.test(addressText)) {
    family = "ipv4";
    value = ipv4Value(addressText);
  } else {
    const v6 = ipv6Value(addressText);
    if (v6 === null) return null;
    family = "ipv6";
    value = v6;
  }
  let prefix = prefixText === undefined ? WIDTH[family] : Number(prefixText);
  if (prefix > WIDTH[family]) return null;
  if (family === "ipv6" && value >> 32n === 0xffffn) {
    if (prefix < 96) return null;
    family = "ipv4";
    value &= 0xffff_ffffn;
    prefix -= 96;
  }
  if (prefix < MIN_PREFIX[family]) return null;
  const network = value & ~((1n << BigInt(WIDTH[family] - prefix)) - 1n);
  const address = family === "ipv4" ? ipv4Text(network) : ipv6Text(network);
  return prefix === WIDTH[family] ? address : `${address}/${prefix}`;
}

/**
 * One blocked referrer domain in the form the API stores it, or null: a
 * pasted address keeps only its hostname, lower case, internationalized
 * names in their ASCII form, at least two labels, no IP address.
 */
export function normalDomain(raw: string): string | null {
  const text = raw.trim();
  let host: string;
  if (text.includes("://")) {
    const url = URL.parse(text);
    if (url === null) return null;
    host = url.hostname;
  } else {
    host = (/^[^/?#]*/.exec(text)?.[0] ?? "").replace(/:\d+$/, "");
  }
  const trimmed = host.trim().toLowerCase().replace(/\.$/, "");
  if (trimmed === "" || trimmed.length > 253 || /[\s/:@*?#\\[\]]/.test(trimmed)) return null;
  const url = URL.parse(`http://${trimmed}`);
  if (url === null || url.port !== "" || url.pathname !== "/") return null;
  const domain = url.hostname;
  if (!domain.includes(".") || /^[\d.]+$/.test(domain)) return null;
  if (PUBLIC_SUFFIXES.has(domain)) return null;
  return domain;
}

/** Common two-label public suffixes, as the API refuses them (blocked-referrers.ts). */
const PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  "co.uk",
  "org.uk",
  "me.uk",
  "ac.uk",
  "gov.uk",
  "ltd.uk",
  "plc.uk",
  "net.uk",
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "gov.au",
  "co.nz",
  "org.nz",
  "net.nz",
  "co.jp",
  "ne.jp",
  "or.jp",
  "ac.jp",
  "go.jp",
  "co.kr",
  "or.kr",
  "co.in",
  "net.in",
  "org.in",
  "gov.in",
  "co.za",
  "org.za",
  "co.id",
  "co.il",
  "co.th",
  "com.br",
  "net.br",
  "org.br",
  "gov.br",
  "com.cn",
  "net.cn",
  "org.cn",
  "gov.cn",
  "com.mx",
  "com.ar",
  "com.co",
  "com.tr",
  "com.sg",
  "com.hk",
  "com.tw",
  "com.my",
  "com.ph",
  "com.vn",
  "com.pk",
  "com.ng",
  "com.eg",
  "com.sa",
  "com.ua",
  "com.pl",
  "com.es",
  "com.pe",
]);

/** What a text box holds, as the API will store it, or why it would refuse it. */
export type ListCheck = { ok: true; entries: string[] } | { ok: false; message: string };

function checkList(
  text: string,
  normal: (line: string) => string | null,
  max: number,
  invalid: (line: string) => string,
  tooMany: string,
  refuse: (entry: string) => string | null = () => null,
): ListCheck {
  const entries: string[] = [];
  for (const line of linesOf(text)) {
    const entry = normal(line);
    if (entry === null) return { ok: false, message: invalid(line) };
    const refused = refuse(entry);
    if (refused !== null) return { ok: false, message: refused };
    if (!entries.includes(entry)) entries.push(entry);
  }
  return entries.length > max ? { ok: false, message: tooMany } : { ok: true, entries };
}

export function checkAddresses(text: string): ListCheck {
  return checkList(
    text,
    normalAddress,
    MAX_BLOCKED_ADDRESSES,
    (line) =>
      `"${line.slice(0, 60)}" is not an IP address or range. Enter an address such as 203.0.113.7, or a range such as 203.0.113.0/24 (at most a /${MIN_PREFIX.ipv4} for IPv4, a /${MIN_PREFIX.ipv6} for IPv6).`,
    `Enter at most ${MAX_BLOCKED_ADDRESSES} addresses and ranges.`,
  );
}

/** `allowedHostnames`: the project's sites, which a blocked referrer must not be, nor a parent of. */
export function checkReferrers(text: string, allowedHostnames: readonly string[] = []): ListCheck {
  return checkList(
    text,
    normalDomain,
    MAX_BLOCKED_REFERRERS,
    (line) =>
      `"${line.slice(0, 60)}" is not a domain you can block. Enter a domain such as spam.example, not a public suffix such as co.uk. It also blocks its subdomains.`,
    `Enter at most ${MAX_BLOCKED_REFERRERS} domains.`,
    (domain) => {
      const own = allowedHostnames.find(
        (hostname) => hostname === domain || hostname.endsWith(`.${domain}`),
      );
      return own === undefined
        ? null
        : `"${domain}" would block your own site, ${own}: its pages refer visitors to each other. Remove it.`;
    },
  );
}
