import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { QueryParams } from "../src/clickhouse/query.ts";
import { type Channel, channelSql } from "../src/visits/channel.ts";
import { createTestClickHouse, type TestClickHouse } from "./helpers/test-clickhouse.ts";

/*
 * The rules that group visits into channels (docs/web-analytics.md,
 * "Channels"), run by ClickHouse over a plain table of first events.
 */

let clickhouse: TestClickHouse;

beforeAll(async () => {
  clickhouse = await createTestClickHouse();
});

afterAll(async () => {
  await clickhouse?.destroy();
});

interface Case {
  referrer?: string;
  source?: string;
  medium?: string;
  campaign?: string;
}

/** The project's own hostname: a referrer on it is no source. */
const OWN = ["shop.example"];

async function channelsOf(cases: readonly Case[]): Promise<Channel[]> {
  const params = new QueryParams();
  const channel = channelSql(OWN, params);
  const text = (value: string | undefined) => params.add(value ?? null, "Nullable(String)");
  const rows = cases
    .map(
      (item, index) =>
        `SELECT ${index} AS n, ${text(item.referrer)} AS referrer, ${text(item.source)} AS utm_source,
                ${text(item.medium)} AS utm_medium, ${text(item.campaign)} AS utm_campaign`,
    )
    .join(" UNION ALL ");
  const result = await clickhouse.client.query({
    query: `SELECT n, ${channel} AS channel FROM (${rows}) ORDER BY n`,
    query_params: params.values,
    format: "JSONEachRow",
  });
  const answer = await result.json<{ channel: Channel }>();
  return answer.map((row) => row.channel);
}

describe("each channel", () => {
  test.each<[Channel, Case]>([
    ["Direct", {}],
    ["Organic search", { referrer: "https://www.google.com/" }],
    ["Paid search", { referrer: "https://www.google.com/", source: "google", medium: "cpc" }],
    ["Organic social", { referrer: "https://t.co/Ab12" }],
    ["Paid social", { source: "facebook", medium: "paid" }],
    ["Email", { source: "newsletter", medium: "email", campaign: "november" }],
    ["AI assistants", { referrer: "https://chatgpt.com/" }],
    ["Display", { source: "adnetwork", medium: "display" }],
    ["Referral", { referrer: "https://blog.example.org/a-review" }],
    ["Other", { source: "flyer", medium: "print" }],
  ])("%s", async (channel, item) => {
    expect(await channelsOf([item])).toEqual([channel]);
  });
});

describe("edge cases", () => {
  test.each<[string, Case, Channel]>([
    // No referrer, but a medium: the tags decide.
    ["utm_medium=email without a referrer", { medium: "email" }, "Email"],
    ["utm_medium=cpc without a source or referrer", { medium: "cpc" }, "Paid search"],
    ["utm_medium=organic without a referrer", { medium: "organic" }, "Organic search"],
    ["utm_medium=social without a referrer", { medium: "social" }, "Organic social"],
    ["an unknown utm_medium without a referrer", { medium: "qr-code" }, "Other"],
    ["only a campaign", { campaign: "launch" }, "Other"],
    // The site's own host is no source.
    ["the site's own host as referrer", { referrer: "https://shop.example/pricing" }, "Direct"],
    ["the site's own host with www.", { referrer: "https://www.shop.example/" }, "Direct"],
    [
      "the site's own host, with a tag",
      { referrer: "https://shop.example/", medium: "email" },
      "Email",
    ],
    // Hosts and their subdomains, and country domains.
    ["google.co.uk", { referrer: "https://www.google.co.uk/" }, "Organic search"],
    ["a subdomain of a listed site", { referrer: "https://l.facebook.com/" }, "Organic social"],
    ["Google's other sites are referrals", { referrer: "https://docs.google.com/" }, "Referral"],
    [
      "an assistant under Google's domain",
      { referrer: "https://gemini.google.com/" },
      "AI assistants",
    ],
    ["webmail", { referrer: "https://mail.google.com/" }, "Email"],
    // Android apps send their package name.
    ["the Gmail app", { referrer: "android-app://com.google.android.gm" }, "Email"],
    [
      "the Google app",
      { referrer: "android-app://com.google.android.googlequicksearchbox" },
      "Organic search",
    ],
    // Sources as names or domains, in any case, with spaces.
    ["a source written as a domain", { source: "chatgpt.com" }, "AI assistants"],
    ["a source in capitals", { source: " LinkedIn " }, "Organic social"],
    ["a medium in capitals", { source: "Google", medium: "CPC" }, "Paid search"],
    [
      "paid on a social site",
      { referrer: "https://www.instagram.com/", medium: "cpc" },
      "Paid social",
    ],
    ["display ads from a search engine", { source: "google", medium: "display" }, "Display"],
    ["other paid ads", { source: "partner", medium: "paid" }, "Display"],
    ["utm_medium=referral", { source: "partner", medium: "referral" }, "Referral"],
    // The medium wins over the source's kind.
    ["a newsletter sent from a social site", { source: "linkedin", medium: "email" }, "Email"],
  ])("%s", async (_, item, channel) => {
    expect(await channelsOf([item])).toEqual([channel]);
  });
});
