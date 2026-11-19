import { parseHostname } from "./projects.ts";

/** Matches the projects table's check (migration 0008_spam_rules). */
export const MAX_BLOCKED_REFERRERS = 100;

/**
 * One blocked referrer domain in its stored form, or null when it is not a
 * domain. A pasted address keeps only its hostname: "https://Spam.Example:8080/x"
 * is "spam.example". Lower case, without a trailing dot, internationalized
 * names in their ASCII form ("bücher.example" is "xn--bcher-kva.example"),
 * as browsers send them. At least two labels: "com" would block every
 * .com referrer. Each entry also matches its subdomains
 * (enrichment/referrer-spam.ts).
 */
export function parseBlockedReferrer(raw: string): string | null {
  const text = raw.trim();
  let hostname: string | null;
  if (text.includes("://")) {
    const url = URL.parse(text);
    hostname = url === null || url.hostname === "" ? null : parseHostname(url.hostname);
  } else {
    // A host with a port or path, without a scheme: as typed from the address bar.
    const host = /^[^/?#]*/.exec(text)?.[0].replace(/:\d+$/, "") ?? "";
    hostname = parseHostname(host);
  }
  if (hostname === null || hostname.startsWith("[") || !hostname.includes(".")) return null;
  // An IP address is no domain: blocked addresses are the setting for those.
  if (/^[\d.]+$/.test(hostname)) return null;
  // A public suffix would block every site under it.
  if (PUBLIC_SUFFIXES.has(hostname)) return null;
  return hostname;
}

/**
 * Common public suffixes of two labels, under which anyone registers a
 * domain: blocking one would block every site under it. Not the whole
 * Public Suffix List, which no dependency provides here: entries of one
 * label ("com") are refused anyway, and these are the second levels most
 * sites live under. Kept the same in the dashboard
 * (apps/web/src/features/projects/spam-rules.ts).
 */
export const PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
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

export type BlockedReferrersResult =
  | { ok: true; domains: string[] }
  | { ok: false; message: string };

/**
 * A project's blocked referrers, checked, normalised, and without repeats;
 * or what is wrong, naming the first bad entry. The dashboard checks the
 * same rules as the user types (apps/web/src/features/projects/spam-rules.ts).
 */
export function parseBlockedReferrers(
  raw: readonly string[],
  /** The project's allowed hostnames: blocking one of them, or a parent, is refused. */
  allowedHostnames: readonly string[] = [],
): BlockedReferrersResult {
  const domains: string[] = [];
  for (const entry of raw) {
    const domain = parseBlockedReferrer(entry);
    if (domain === null) {
      return {
        ok: false,
        message: `"${entry.slice(0, 100)}" is not a domain you can block. Enter a domain such as spam.example, not a public suffix such as co.uk. It also blocks its subdomains.`,
      };
    }
    const own = allowedHostnames.find(
      (hostname) => hostname === domain || hostname.endsWith(`.${domain}`),
    );
    if (own !== undefined) {
      return {
        ok: false,
        message: `"${domain}" would block your own site, ${own}: its pages refer visitors to each other. Remove it.`,
      };
    }
    if (!domains.includes(domain)) domains.push(domain);
  }
  if (domains.length > MAX_BLOCKED_REFERRERS) {
    return {
      ok: false,
      message: `A project blocks at most ${MAX_BLOCKED_REFERRERS} referrer domains.`,
    };
  }
  return { ok: true, domains };
}
