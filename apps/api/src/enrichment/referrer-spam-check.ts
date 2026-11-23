import { isListedHostname } from "./referrer-spam.ts";

/** The list held 2,355 domains in November 2026; far fewer means a bad download. */
export const MIN_SPAM_DOMAINS = 1000;

/**
 * Reject real referral sources, their parents, and subdomains to avoid dropping
 * real visits.
 */
export const GUARD_DOMAINS = [
  "google.com",
  "bing.com",
  "duckduckgo.com",
  "yahoo.com",
  "baidu.com",
  "yandex.ru",
  "facebook.com",
  "instagram.com",
  "x.com",
  "t.co",
  "linkedin.com",
  "reddit.com",
  "youtube.com",
  "github.com",
  "wikipedia.org",
  "ok.ru",
  "vk.com",
  "news.ycombinator.com",
] as const;

const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Reject hosting platform domains and their parents to protect all hosted sites.
 * Spam subdomains such as eoriseome.netlify.app may still be listed.
 */
export const GUARD_PLATFORMS = [
  "blogspot.com",
  "github.io",
  "wordpress.com",
  "medium.com",
  "substack.com",
  "tumblr.com",
  "pages.dev",
  "netlify.app",
  "vercel.app",
] as const;

export type SpamListCheck =
  | {
      ok: true;
      domains: string[];
      /** Entries of the download left out on purpose (the script's IGNORED_UPSTREAM). */
      ignored: string[];
    }
  | { ok: false; reason: string };

/**
 * Checks a downloaded spammers.txt before it replaces the shipped copy
 * (scripts/update-referrer-spam.ts): every line that is not blank is a
 * hostname, there are at least MIN_SPAM_DOMAINS, none is a GUARD_DOMAINS
 * entry, a parent of one, or a subdomain of one, and none is a
 * GUARD_PLATFORMS entry or a parent of one. Entries in `ignored` (the
 * script's IGNORED_UPSTREAM: upstream entries left out on purpose) are
 * dropped first, so a guard that fails can be passed with a reason. The
 * domains come back in lower case, sorted, without repeats.
 */
export function checkSpamList(
  text: string,
  ignored: ReadonlySet<string> = new Set(),
): SpamListCheck {
  const left: string[] = [];
  const domains = new Set<string>();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const domain = line.trim().toLowerCase();
    if (domain === "") continue;
    if (!HOSTNAME.test(domain)) {
      return { ok: false, reason: `line ${index + 1} is not a hostname: "${line.slice(0, 100)}"` };
    }
    if (ignored.has(domain)) {
      if (!left.includes(domain)) left.push(domain);
      continue;
    }
    domains.add(domain);
  }
  if (domains.size < MIN_SPAM_DOMAINS) {
    return { ok: false, reason: `only ${domains.size} domains, fewer than ${MIN_SPAM_DOMAINS}` };
  }
  // Subdomains of guarded platforms may be listed; guarded referral subdomains may not.
  const caught = [...domains].filter(
    (domain) =>
      GUARD_DOMAINS.some(
        (guard) =>
          isListedHostname(domain, new Set([guard])) || isListedHostname(guard, new Set([domain])),
      ) || GUARD_PLATFORMS.some((platform) => isListedHostname(platform, new Set([domain]))),
  );
  if (caught.length > 0) {
    return {
      ok: false,
      reason: `it would block real referrers: ${caught.toSorted().join(", ")}. Leave an entry out with a reason in IGNORED_UPSTREAM if it is wrong upstream`,
    };
  }
  return { ok: true, domains: [...domains].toSorted(), ignored: left.toSorted() };
}

export function listChanges(
  before: Iterable<string>,
  after: Iterable<string>,
): { added: string[]; removed: string[] } {
  const old = new Set(before);
  const now = new Set(after);
  return {
    added: [...now].filter((domain) => !old.has(domain)),
    removed: [...old].filter((domain) => !now.has(domain)),
  };
}
