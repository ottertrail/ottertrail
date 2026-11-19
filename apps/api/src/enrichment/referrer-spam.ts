import { REFERRER_SPAM_ADDITIONS } from "./referrer-spam/additions.ts";
import { REFERRER_SPAM_LIST } from "./referrer-spam/list.ts";

/**
 * The domains of a referrer spam list, one per line, as a set: lower case,
 * without a trailing dot; blank lines, comments (from # to the end of the
 * line), and lines that are not a domain left out. Used for the shipped
 * lists and by the script that refreshes Matomo's.
 */
export function parseSpamList(text: string): Set<string> {
  const domains = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const hash = line.indexOf("#");
    const domain = (hash === -1 ? line : line.slice(0, hash))
      .trim()
      .toLowerCase()
      .replace(/\.$/, "");
    // A domain: labels of letters, digits, and hyphens, with at least one dot.
    if (/^(?:[a-z0-9-]{1,63}\.)+[a-z0-9-]{1,63}$/.test(domain) && domain.length <= 253) {
      domains.add(domain);
    }
  }
  return domains;
}

/**
 * Whether a hostname is one of `domains` or a subdomain of one:
 * "buttons.spam.example" and "spam.example" match "spam.example";
 * "notspam.example" does not.
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
 * The shared lists, shipped in the repository: Matomo's community list
 * (referrer-spam/list.ts, refreshed by a script) and Ottertrail's own
 * additions (referrer-spam/additions.ts, edited by hand).
 */
const SPAM_DOMAINS = new Set([
  ...parseSpamList(REFERRER_SPAM_LIST),
  ...parseSpamList(REFERRER_SPAM_ADDITIONS),
]);

/**
 * Whether a referrer, as a browser sent it, comes from a referrer spam
 * domain (docs/web-analytics.md, "Referrer spam"): one of the shared lists,
 * or the project's own blocked referrers. A referrer that is not a URL is
 * not spam: it is dropped later, as before.
 */
export function isReferrerSpam(
  referrer: string | undefined,
  projectDomains: ReadonlySet<string> | null = null,
  shared: ReadonlySet<string> = SPAM_DOMAINS,
  /**
   * The project's allowed hostnames. A referrer on one of them is the
   * site's own previous page (the tracker sends it on every page after the
   * first), never spam, whatever the lists hold.
   */
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
