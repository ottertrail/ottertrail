import { describe, expect, test } from "vite-plus/test";

import { VISITOR_DAILY_EVENT_CAP, VisitorCap } from "../src/collection/visitor-cap.ts";
import {
  checkSpamList,
  GUARD_DOMAINS,
  GUARD_PLATFORMS,
  listChanges,
  MIN_SPAM_DOMAINS,
} from "../src/enrichment/referrer-spam-check.ts";
import { isReferrerSpam, parseSpamList } from "../src/enrichment/referrer-spam.ts";
import { REFERRER_SPAM_ADDITIONS } from "../src/enrichment/referrer-spam/additions.ts";
import { REFERRER_SPAM_COMMIT, REFERRER_SPAM_LIST } from "../src/enrichment/referrer-spam/list.ts";
import {
  blockListOf,
  isBlockedAddress,
  MAX_BLOCKED_ADDRESSES,
  ownAddress,
  parseBlockedAddresses,
} from "../src/projects/blocked-addresses.ts";
import { MAX_BLOCKED_REFERRERS, parseBlockedReferrers } from "../src/projects/blocked-referrers.ts";

describe("blocked addresses", () => {
  test("are normalised: mapped IPv6 as IPv4, a range as its network, one address without /32, repeats dropped", () => {
    expect(
      parseBlockedAddresses([
        " 203.0.113.7 ",
        "203.0.113.7/32",
        "10.1.2.3/8",
        "::ffff:198.51.100.9",
        "::FFFF:198.51.100.0/120",
        "2001:DB8:0:0::1",
        "2001:db8::1/128",
        "2001:db8:abcd:12:ff::5/64",
      ]),
    ).toEqual({
      ok: true,
      addresses: [
        "203.0.113.7",
        "10.0.0.0/8",
        "198.51.100.9",
        "198.51.100.0/24",
        "2001:db8::1",
        "2001:db8:abcd:12::/64",
      ],
    });
  });

  test.each([
    "nope",
    "",
    "203.0.113",
    "203.0.113.7/33",
    "10.0.0.0/7",
    "2001::/15",
    "::ffff:1.2.3.4/90",
    "fe80::1%eth0",
    "203.0.113.1-203.0.113.9",
    "example.com",
  ])("refuse %j, naming it", (entry) => {
    const result = parseBlockedAddresses(["203.0.113.7", entry]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain(`"${entry}"`);
  });

  test(`are at most ${MAX_BLOCKED_ADDRESSES}, counted after repeats are dropped`, () => {
    const addresses = Array.from({ length: MAX_BLOCKED_ADDRESSES }, (_, i) => `198.51.100.${i}`);
    expect(parseBlockedAddresses([...addresses, "198.51.100.0"]).ok).toBe(true);
    expect(parseBlockedAddresses([...addresses, "203.0.113.1"]).ok).toBe(false);
  });

  test("match IPv4, IPv6, ranges, and an IPv4-mapped client address", () => {
    const list = blockListOf(["203.0.113.7", "10.0.0.0/8", "2001:db8::/64", "2001:db8:1::9"]);
    expect(isBlockedAddress(list, "203.0.113.7")).toBe(true);
    expect(isBlockedAddress(list, "203.0.113.8")).toBe(false);
    expect(isBlockedAddress(list, "10.200.3.4")).toBe(true);
    expect(isBlockedAddress(list, "::ffff:203.0.113.7")).toBe(true);
    expect(isBlockedAddress(list, "::ffff:10.9.9.9")).toBe(true);
    expect(isBlockedAddress(list, "2001:db8::1234:5678")).toBe(true);
    expect(isBlockedAddress(list, "2001:db8:0:1::1")).toBe(false);
    expect(isBlockedAddress(list, "2001:db8:1::9")).toBe(true);
    expect(isBlockedAddress(blockListOf([]), "203.0.113.7")).toBe(false);
  });

  test("the requester's own address: IPv4 as it is, mapped as IPv4, IPv6 with its /64", () => {
    expect(ownAddress("203.0.113.7")).toEqual({ address: "203.0.113.7", network: null });
    expect(ownAddress("::ffff:203.0.113.7")).toEqual({ address: "203.0.113.7", network: null });
    expect(ownAddress("2001:DB8:1:2:3::7")).toEqual({
      address: "2001:db8:1:2:3::7",
      network: "2001:db8:1:2::/64",
    });
  });
});

describe("blocked referrers", () => {
  test("are normalised: lower case, no scheme, path, or port, punycode, repeats dropped", () => {
    expect(
      parseBlockedReferrers([
        "Spam.Example",
        "https://ads.other.example:8080/landing?x=1",
        "spam.example.",
        "bücher.example",
        "www.spam.example/path",
        "promo.example:443",
      ]),
    ).toEqual({
      ok: true,
      domains: [
        "spam.example",
        "ads.other.example",
        "xn--bcher-kva.example",
        "www.spam.example",
        "promo.example",
      ],
    });
  });

  test.each([
    "com",
    "co.uk",
    "https://com.au/",
    "",
    "not a domain",
    "203.0.113.7",
    "https://[2001:db8::1]/",
    "*.spam.example",
  ])("refuse %j", (entry) => {
    expect(parseBlockedReferrers([entry]).ok).toBe(false);
  });

  test("refuse the project's own site, or a parent of it, naming the site", () => {
    const allowed = ["www.example.com", "shop.example.org"];
    for (const entry of ["example.com", "www.example.com", "https://example.org/"]) {
      const result = parseBlockedReferrers([entry], allowed);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.message).toContain("would block your own site");
    }
    // A sibling, or a child, of the site is not the site.
    expect(parseBlockedReferrers(["ads.example.com", "a.www.example.com"], allowed).ok).toBe(true);
  });

  test(`are at most ${MAX_BLOCKED_REFERRERS}`, () => {
    const domains = Array.from({ length: MAX_BLOCKED_REFERRERS }, (_, i) => `spam-${i}.example`);
    expect(parseBlockedReferrers([...domains, "spam-0.example"]).ok).toBe(true);
    expect(parseBlockedReferrers([...domains, "one-more.example"]).ok).toBe(false);
  });
});

describe("referrer spam lists", () => {
  test("the community list is shipped, pinned to a commit", () => {
    expect(REFERRER_SPAM_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    expect(parseSpamList(REFERRER_SPAM_LIST).size).toBeGreaterThanOrEqual(MIN_SPAM_DOMAINS);
    expect(checkSpamList(REFERRER_SPAM_LIST).ok).toBe(true);
  });

  test("a domain, and its subdomains, from each source match; a lookalike does not", () => {
    expect(isReferrerSpam("https://semalt.com/")).toBe(true);
    expect(isReferrerSpam("https://www.semalt.com/page")).toBe(true);
    expect(isReferrerSpam("https://notsemalt.com/")).toBe(false);
    expect(isReferrerSpam("https://semalt.com.example.org/")).toBe(false);
    expect(isReferrerSpam("https://check-additions.ottertrail.invalid/")).toBe(true);
    const own = new Set(["spam.example"]);
    expect(isReferrerSpam("https://a.spam.example/", own)).toBe(true);
    expect(isReferrerSpam("https://a.spam.example/")).toBe(false);
    expect(isReferrerSpam("not a url", own)).toBe(false);
    // The site's own pages are never spam, whatever a list holds.
    expect(isReferrerSpam("https://semalt.com/", null, undefined, ["semalt.com"])).toBe(false);
    expect(isReferrerSpam("https://a.spam.example/", own, undefined, ["a.spam.example"])).toBe(
      false,
    );
    expect(isReferrerSpam(undefined, own)).toBe(false);
  });

  test("the additions file takes comments", () => {
    expect([...parseSpamList(REFERRER_SPAM_ADDITIONS)]).toEqual([
      "check-additions.ottertrail.invalid",
    ]);
    expect([...parseSpamList("# a comment\nSpam.Example  # seen 2026\n\nnot a domain\n")]).toEqual([
      "spam.example",
    ]);
  });
});

const domains = (count: number) => Array.from({ length: count }, (_, i) => `spam-${i}.example`);

describe("the refresh script's checks", () => {
  test("accept a list of hostnames, lower case, sorted, without repeats", () => {
    const result = checkSpamList(
      [...domains(MIN_SPAM_DOMAINS), "", "SPAM-0.example", "zz.example"].join("\r\n"),
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.domains.length).toBe(MIN_SPAM_DOMAINS + 1);
    expect(result.ok && result.domains[0]).toBe("spam-0.example");
  });

  test("refuse a line that is not a hostname", () => {
    const result = checkSpamList([...domains(MIN_SPAM_DOMAINS), "alienwheel.e-"].join("\n"));
    expect(result).toEqual({
      ok: false,
      reason: `line ${MIN_SPAM_DOMAINS + 1} is not a hostname: "alienwheel.e-"`,
    });
    expect(checkSpamList([...domains(MIN_SPAM_DOMAINS), "<html>"].join("\n")).ok).toBe(false);
  });

  test(`refuse fewer than ${MIN_SPAM_DOMAINS} domains`, () => {
    expect(checkSpamList(domains(MIN_SPAM_DOMAINS - 1).join("\n")).ok).toBe(false);
  });

  test.each([
    ...GUARD_DOMAINS,
    "ycombinator.com",
    "www.google.com",
    "l.facebook.com",
    "m.youtube.com",
    "en.wikipedia.org",
    "out.reddit.com",
    ...GUARD_PLATFORMS,
  ])("refuse a list that would block real referrers: %s", (domain) => {
    const result = checkSpamList([...domains(MIN_SPAM_DOMAINS), domain].join("\n"));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain(`real referrers: ${domain}`);
  });

  test("accept a site on a hosting platform: only the platform's own domain is guarded", () => {
    const result = checkSpamList(
      [...domains(MIN_SPAM_DOMAINS), "eoriseome.netlify.app", "spam.blogspot.com"].join("\n"),
    );
    expect(result.ok).toBe(true);
  });

  test("leave out the ignored entries, which pass a failed guard", () => {
    const text = [...domains(MIN_SPAM_DOMAINS), "www.google.com"].join("\n");
    expect(checkSpamList(text).ok).toBe(false);
    const result = checkSpamList(text, new Set(["www.google.com"]));
    expect(result).toMatchObject({ ok: true, ignored: ["www.google.com"] });
    expect(result.ok && result.domains).not.toContain("www.google.com");
  });

  test("list what was added and removed", () => {
    expect(listChanges(["a.example", "b.example"], ["b.example", "c.example"])).toEqual({
      added: ["c.example"],
      removed: ["a.example"],
    });
  });
});

describe("the daily cap per visitor", () => {
  test(`is ${VISITOR_DAILY_EVENT_CAP} events`, () => {
    const cap = new VisitorCap();
    const taken = Array.from({ length: VISITOR_DAILY_EVENT_CAP + 2 }, () =>
      cap.take("p", "2026-11-16", "1"),
    );
    expect(taken.filter(Boolean)).toHaveLength(VISITOR_DAILY_EVENT_CAP);
    expect(taken.at(-1)).toBe(false);
    // Another day, visitor, or project counts apart.
    expect(cap.take("p", "2026-11-17", "1")).toBe(true);
    expect(cap.take("p", "2026-11-16", "2")).toBe(true);
    expect(cap.take("q", "2026-11-16", "1")).toBe(true);
  });

  test("forgets the visitor counted least recently past its size, which starts again", () => {
    const cap = new VisitorCap({ cap: 1, maxKeys: 2 });
    expect(cap.take("p", "d", "1")).toBe(true);
    expect(cap.take("p", "d", "2")).toBe(true);
    expect(cap.take("p", "d", "1")).toBe(false);
    expect(cap.take("p", "d", "3")).toBe(true);
    // 2 was counted least recently: forgotten, it starts again.
    expect(cap.take("p", "d", "2")).toBe(true);
    expect(cap.take("p", "d", "1")).toBe(true);
  });

  test("untake gives back an event that was not stored", () => {
    const cap = new VisitorCap({ cap: 1 });
    expect(cap.take("p", "d", "1")).toBe(true);
    cap.untake("p", "d", "1");
    expect(cap.take("p", "d", "1")).toBe(true);
    expect(cap.take("p", "d", "1")).toBe(false);
  });
});
