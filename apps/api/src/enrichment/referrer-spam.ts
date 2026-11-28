import { REFERRER_SPAM_ADDITIONS } from "./referrer-spam/additions.ts";
import { REFERRER_SPAM_LIST } from "./referrer-spam/list.ts";

/**
 * Normalizes hostnames to lowercase without trailing dots. Skips blank lines,
 * # comments, and invalid domains. Used for the shipped lists and by their refresh script.
 */
export function parseSpamList(text: string): Set<string> {
  const domains = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const hash = line.indexOf("#");
    const domain = (hash === -1 ? line : line.slice(0, hash))
      .trim()
      .toLowerCase()
      .replace(/\.$/, "");
    if (/^(?:[a-z0-9-]{1,63}\.)+[a-z0-9-]{1,63}$/.test(domain) && domain.length <= 253) {
      domains.add(domain);
    }
  }
  return domains;
}

/**
 * Matches domains and subdomains: spam.example matches buttons.spam.example,
 * but not notspam.example.
 */
export function isListedHostname(hostname: string, domains: ReadonlySet<string>): boolean {
  let name = hostname.toLowerCase().replace(/\.$/, "");
  for (;;) {
    if (domains.has(name)) return true;
    const dot = name.indexOf(".");
    if (dot === -1) return false;
    name = name.slice(dot + 1);
  }
}

/**
 * The shared lists, shipped in the repository: the community referrer spam list
 * (referrer-spam/list.ts, refreshed by a script) and Ottertrail's own
 * additions (referrer-spam/additions.ts, edited by hand).
 */
const SPAM_DOMAINS = new Set([
  ...parseSpamList(REFERRER_SPAM_LIST),
  ...parseSpamList(REFERRER_SPAM_ADDITIONS),
]);

/**
 * Checks shared lists and project blocks (docs/web-analytics.md, "Referrer spam").
 * Invalid URLs are dropped later without marking the visit as spam.
 */
export function isReferrerSpam(
  referrer: string | undefined,
  projectDomains: ReadonlySet<string> | null = null,
  shared: ReadonlySet<string> = SPAM_DOMAINS,
  /** Exempt the project's own hostnames so a listed domain cannot drop later pages. */
  allowedHostnames: readonly string[] = [],
): boolean {
  if (referrer === undefined || referrer === "") return false;
  const url = URL.parse(referrer);
  if (url === null || url.hostname === "") return false;
  if (allowedHostnames.includes(url.hostname.toLowerCase())) return false;
  return (
    isListedHostname(url.hostname, shared) ||
    (projectDomains !== null && isListedHostname(url.hostname, projectDomains))
  );
}
