import type { QueryParams } from "../clickhouse/query.ts";
import { referrerHostSql } from "./visit-source.ts";

/**
 * Acquisition channels: a visit's kind of source, worked out from its first
 * event's utm_medium, utm_source, and referrer host when a report asks
 * (docs/web-analytics.md, "Channels"). Nothing is stored, so old visits get
 * a channel too, and a change to the rules or the lists applies to all of
 * them at once.
 *
 * The lists are Ottertrail's own, short on purpose: the sites that send most
 * visits of each kind. A site missing from them counts as Referral.
 */
export const CHANNELS = [
  "Direct",
  "Organic search",
  "Paid search",
  "Organic social",
  "Paid social",
  "Email",
  "AI assistants",
  "Display",
  "Referral",
  "Other",
] as const;

export type Channel = (typeof CHANNELS)[number];

/** Hosts listed here match themselves and their subdomains. */
export const SEARCH_DOMAINS = [
  "bing.com",
  "duckduckgo.com",
  "search.yahoo.com",
  "search.yahoo.co.jp",
  "baidu.com",
  "ecosia.org",
  "qwant.com",
  "startpage.com",
  "search.brave.com",
  "kagi.com",
  "naver.com",
  "seznam.cz",
  "sogou.com",
  "so.com",
  "daum.net",
  "ask.com",
  "search.aol.com",
  "mojeek.com",
  // The Google app on Android.
  "com.google.android.googlequicksearchbox",
];

/**
 * Search engines with a domain per country: google.de, google.co.uk. Only
 * the bare domain, so docs.google.com or news.google.com stay referrals.
 */
export const SEARCH_PATTERN = String.raw`^(google|yandex)(\.[a-z]{2,3}){1,2}$`;

export const SEARCH_SOURCES = [
  "google",
  "bing",
  "duckduckgo",
  "yahoo",
  "baidu",
  "yandex",
  "ecosia",
  "qwant",
  "brave",
  "naver",
];

export const SOCIAL_DOMAINS = [
  "facebook.com",
  "fb.com",
  "fb.me",
  "messenger.com",
  "instagram.com",
  "threads.net",
  "threads.com",
  "x.com",
  "twitter.com",
  "t.co",
  "linkedin.com",
  "lnkd.in",
  "reddit.com",
  "redd.it",
  "youtube.com",
  "youtu.be",
  "tiktok.com",
  "pinterest.com",
  "snapchat.com",
  "tumblr.com",
  "bsky.app",
  "mastodon.social",
  "news.ycombinator.com",
  "quora.com",
  "vk.com",
  "weibo.com",
  "discord.com",
  "t.me",
  "whatsapp.com",
  "wa.me",
  "line.me",
  // Their Android apps.
  "com.facebook.katana",
  "com.instagram.android",
  "com.twitter.android",
  "com.linkedin.android",
  "com.reddit.frontpage",
  "com.zhiliaoapp.musically",
  "org.telegram.messenger",
  "com.discord",
];

export const SOCIAL_SOURCES = [
  "facebook",
  "fb",
  "instagram",
  "ig",
  "twitter",
  "x",
  "linkedin",
  "reddit",
  "youtube",
  "tiktok",
  "pinterest",
  "threads",
  "bluesky",
  "mastodon",
  "snapchat",
  "hackernews",
  "hn",
  "discord",
  "telegram",
  "whatsapp",
];

/** Checked before search and social: gemini.google.com is not Google search. */
export const AI_DOMAINS = [
  "chatgpt.com",
  "chat.openai.com",
  "perplexity.ai",
  "claude.ai",
  "gemini.google.com",
  "copilot.microsoft.com",
  "chat.mistral.ai",
  "chat.deepseek.com",
  "grok.com",
  "meta.ai",
  "you.com",
  "phind.com",
  "poe.com",
  "kimi.com",
  "chat.qwen.ai",
];

export const AI_SOURCES = [
  "chatgpt",
  "openai",
  "perplexity",
  "claude",
  "gemini",
  "copilot",
  "mistral",
  "deepseek",
  "grok",
];

/** Webmail sites, and mail apps on Android, that send a referrer. */
export const EMAIL_DOMAINS = [
  "mail.google.com",
  "outlook.live.com",
  "outlook.office.com",
  "outlook.office365.com",
  "mail.yahoo.com",
  "mail.aol.com",
  "mail.proton.me",
  "app.fastmail.com",
  "mail.zoho.com",
  "mail.yandex.ru",
  "com.google.android.gm",
  "com.microsoft.office.outlook",
];

export const EMAIL_SOURCES = ["email", "e-mail", "newsletter", "mail"];
export const EMAIL_MEDIUMS = ["email", "e-mail", "e_mail", "newsletter", "mail"];

/** Paid on its own: social when the source or referrer is social, search when it is a search engine. */
export const PAID_MEDIUMS = [
  "cpc",
  "ppc",
  "paid",
  "cpm",
  "cpv",
  "cpa",
  "ad",
  "ads",
  "display",
  "banner",
  "retargeting",
  "remarketing",
  "programmatic",
];
/** Without a known source, still search ads: cost per click is how search ads are sold. */
export const CLICK_MEDIUMS = ["cpc", "ppc"];
/** Ads shown on other sites, bought by the view: Display, unless the site is social. */
export const DISPLAY_MEDIUMS = ["display", "banner", "cpm", "cpv", "programmatic"];
export const PAID_SEARCH_MEDIUMS = ["paidsearch", "paid-search", "paid_search", "sem"];
export const PAID_SOCIAL_MEDIUMS = ["paidsocial", "paid-social", "paid_social"];
export const SOCIAL_MEDIUMS = [
  "social",
  "social-media",
  "social_media",
  "social-network",
  "social_network",
  "sm",
  "organic-social",
  "organic_social",
];
export const SEARCH_MEDIUMS = ["organic"];
export const REFERRAL_MEDIUMS = ["referral", "link"];

/**
 * The channel of a visit, as SQL over its first event's columns
 * (visits.ts, FIRST_EVENT_COLUMNS). The first rule that matches wins:
 *
 * 1. A paid medium: Paid social on a social site; Display for display
 *    mediums; Paid search for search mediums, cost per click, or a search
 *    engine; Display for the other ads.
 * 2. Email: an email medium or source, or a webmail referrer.
 * 3. AI assistants: an assistant's site as referrer or source.
 * 4. Organic social: a social medium, or a social site as referrer or source.
 * 5. Organic search: utm_medium=organic, or a search engine.
 * 6. Referral: utm_medium=referral, or any other site as referrer.
 * 7. Other: campaign tags that match none of the above.
 * 8. Direct: no tags and no referrer. A referrer on the project's own
 *    hostnames counts as none.
 *
 * Values are compared in lower case, with spaces around them and a
 * leading www. removed, since tags are typed by hand.
 */
export function channelSql(ownHostnames: readonly string[], params: QueryParams): string {
  const list = (values: readonly string[]) => params.add(values, "Array(String)");
  const medium = "lower(trimBoth(ifNull(utm_medium, '')))";
  const source = String.raw`replaceRegexpOne(lower(trimBoth(ifNull(utm_source, ''))), '^www\\.', '')`;
  const host = `ifNull(${referrerHostSql(ownHostnames, params)}, '')`;

  const inList = (value: string, values: readonly string[]) => `has(${list(values)}, ${value})`;
  /** The referrer host or the source names a site of `domains`, or the source is one of `sources`. */
  const names = (domains: readonly string[], sources: readonly string[], pattern?: string) => {
    const domainList = list(domains);
    const regex = pattern === undefined ? undefined : params.add(pattern, "String");
    return [
      onDomains(host, domainList),
      onDomains(source, domainList),
      inList(source, sources),
      ...(regex === undefined ? [] : [`match(${host}, ${regex})`, `match(${source}, ${regex})`]),
    ].join(" OR ");
  };

  const social = names(SOCIAL_DOMAINS, SOCIAL_SOURCES);
  const search = names(SEARCH_DOMAINS, SEARCH_SOURCES, SEARCH_PATTERN);
  const paid = inList(medium, PAID_MEDIUMS);
  const channel = (name: Channel) => params.add(name, "String");

  return `multiIf(
    ${inList(medium, PAID_SOCIAL_MEDIUMS)} OR (${paid} AND (${social})), ${channel("Paid social")},
    ${inList(medium, DISPLAY_MEDIUMS)}, ${channel("Display")},
    ${inList(medium, PAID_SEARCH_MEDIUMS)} OR ${inList(medium, CLICK_MEDIUMS)} OR (${paid} AND (${search})), ${channel("Paid search")},
    ${paid}, ${channel("Display")},
    ${inList(medium, EMAIL_MEDIUMS)} OR ${names(EMAIL_DOMAINS, EMAIL_SOURCES)}, ${channel("Email")},
    ${names(AI_DOMAINS, AI_SOURCES)}, ${channel("AI assistants")},
    ${inList(medium, SOCIAL_MEDIUMS)} OR ${social}, ${channel("Organic social")},
    ${inList(medium, SEARCH_MEDIUMS)} OR ${search}, ${channel("Organic search")},
    ${inList(medium, REFERRAL_MEDIUMS)} OR ${host} != '', ${channel("Referral")},
    ${medium} != '' OR ${source} != '' OR utm_campaign IS NOT NULL, ${channel("Other")},
    ${channel("Direct")})`;
}

/** `value` is one of `domains` (SQL of an array) or a subdomain of one. */
function onDomains(value: string, domains: string): string {
  return `(${value} != '' AND (has(${domains}, ${value}) OR arrayExists(d -> endsWith(${value}, concat('.', d)), ${domains})))`;
}
