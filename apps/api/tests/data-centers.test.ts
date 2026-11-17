import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import {
  downloadDataCenters,
  findAzureFile,
  HOSTING_NETWORKS,
  LIST_SOURCES,
  parseAws,
  parseAzure,
  parseGeofeed,
  parseGoogleCloud,
  parseOracle,
  parseVultr,
  rangesByNetwork,
} from "../src/enrichment/data-center-sources.ts";
import {
  addressValue,
  type DataCenterFile,
  DataCenters,
  parseRange,
} from "../src/enrichment/data-centers.ts";
import { DATA_CENTERS_STALE_AFTER_DAYS, setUpDataCenters } from "../src/enrichment/setup.ts";

function file(ranges: string[], fetchedAt = "2026-11-17T00:00:00.000Z"): DataCenterFile {
  return {
    version: 1,
    updatedAt: fetchedAt,
    providers: [{ id: "test", name: "Test cloud", source: "test", fetchedAt, ranges }],
  };
}

describe("DataCenters", () => {
  const ranges = DataCenters.from(
    file(["203.0.113.0/25", "2001:db8:100::/40", "198.51.100.10-198.51.100.20", "192.0.2.7"]),
  );

  test.each([
    ["203.0.113.5", true, "inside a block"],
    ["203.0.113.200", false, "just past a block"],
    ["::ffff:203.0.113.5", true, "an IPv4 address on an IPv6 socket"],
    ["2001:db8:1ff:1::1", true, "inside an IPv6 block"],
    ["2001:DB8:100::abcd", true, "an IPv6 address in upper case"],
    ["2001:db8:200::1", false, "outside the IPv6 block"],
    ["198.51.100.15", true, "inside a start-end range"],
    ["198.51.100.21", false, "just past the range"],
    ["192.0.2.7", true, "a single address"],
    ["10.0.0.1", false, "a private address"],
    ["not an address", false, "garbage"],
    ["", false, "nothing"],
  ])("%s: %s (%s)", (ip, expected) => {
    expect(ranges.has(ip)).toBe(expected);
  });

  test("leaves out ranges that are malformed or wider than one provider's", () => {
    const loaded = DataCenters.from(
      file([
        "203.0.113.0/24",
        "0.0.0.0/0",
        "10.0.0.0/7",
        "::/0",
        "203.0.113.0/33",
        "203.0.113.0/x",
        "example.com/24",
        "203.0.113.9-203.0.113.1",
        "203.0.113.1-2001:db8::1",
      ]),
    );
    expect(loaded.skipped).toBe(8);
    expect(loaded.providers).toMatchObject([{ id: "test", ranges: 1 }]);
    expect(loaded.has("8.8.8.8")).toBe(false);
  });

  test.each([
    ["0.0.0.0-255.255.255.255", "every IPv4 address"],
    ["1.0.0.0-2.0.0.0", "more than a /8"],
    ["::ffff:0:0/96", "IPv6 rules that stand for every IPv4 address"],
    ["::/16", "the start of IPv6, which holds IPv4-compatible addresses"],
    ["2002::/16", "6to4, whose addresses stand for IPv4 ones"],
    ["fc00::/7", "private IPv6"],
    ["10.0.0.0/8", "private IPv4"],
    ["172.16.0.0-172.16.0.255", "a private range inside 172.16.0.0/12"],
    ["192.167.255.0-192.168.0.10", "a range that runs into 192.168.0.0/16"],
    ["127.0.0.1", "loopback"],
    ["100.64.0.0/10", "carrier-grade NAT"],
    ["224.0.0.0/4", "multicast"],
  ])("refuses %s (%s)", (range) => {
    expect(parseRange(range)).toBeNull();
  });

  test("takes CIDR blocks, single addresses, and start-end ranges of public addresses", () => {
    expect(parseRange("203.0.113.0/24")).toMatchObject({ family: "ipv4", prefix: 24 });
    expect(parseRange("203.0.113.77")).toMatchObject({ start: parseRange("203.0.113.77")?.end });
    expect(parseRange("2001:db8::/32")).toMatchObject({ family: "ipv6", prefix: 32 });
    expect(parseRange("198.51.100.10-198.51.100.20")).toMatchObject({
      text: ["198.51.100.10", "198.51.100.20"],
    });
    // Host bits set: the block they belong to.
    expect(parseRange("203.0.113.77/24")?.start).toBe(addressValue("203.0.113.0")?.value);
  });

  test("reads IPv6 in every written form", () => {
    expect(addressValue("::1")?.value).toBe(1n);
    expect(addressValue("2001:db8::1")?.value).toBe((0x2001_0db8n << 96n) | 1n);
    expect(addressValue("::ffff:192.0.2.1")?.value).toBe((0xffffn << 32n) | 0xc000_0201n);
    expect(addressValue("2001:DB8:0:0:0:0:0:1")?.value).toBe(addressValue("2001:db8::1")?.value);
    expect(addressValue("fe80::1%eth0")).toBeNull();
    expect(addressValue("2001:db8::1::2")).toBeNull();
  });

  test("refuses anything but a version 1 file", () => {
    expect(() => DataCenters.from({ version: 2, updatedAt: "", providers: [] })).toThrow(
      "not a data-center file",
    );
    expect(() => DataCenters.from([])).toThrow("not a data-center file");
    expect(() => DataCenters.from({ ...file([]), providers: [{ id: "x" }] })).toThrow(
      "not a data-center file",
    );
    // A provider's date must be one: otherwise the file would never seem stale.
    expect(() => DataCenters.from(file(["203.0.113.0/24"], "yesterday"))).toThrow(
      "not a data-center file",
    );
  });
});

describe("the providers' formats", () => {
  test("AWS: only the EC2 ranges, IPv4 and IPv6", () => {
    const text = JSON.stringify({
      prefixes: [
        { ip_prefix: "203.0.113.0/24", service: "AMAZON" },
        { ip_prefix: "203.0.113.0/24", service: "EC2" },
        { ip_prefix: "198.51.100.0/24", service: "CLOUDFRONT" },
      ],
      ipv6_prefixes: [{ ipv6_prefix: "2001:db8::/32", service: "EC2" }],
    });
    expect(parseAws(text)).toEqual(["203.0.113.0/24", "2001:db8::/32"]);
  });

  test("Google Cloud", () => {
    const text = JSON.stringify({
      prefixes: [{ ipv4Prefix: "203.0.113.0/24" }, { ipv6Prefix: "2001:db8::/32" }, {}],
    });
    expect(parseGoogleCloud(text)).toEqual(["203.0.113.0/24", "2001:db8::/32"]);
  });

  test("Azure: the weekly file's link, then the AzureCloud tag", () => {
    const page =
      '<a href="https://download.microsoft.com/download/7/1/d/71d86715-5596-4529-9b13-da13a5de5b63/ServiceTags_Public_20261109.json">';
    expect(findAzureFile(page)).toBe(
      "https://download.microsoft.com/download/7/1/d/71d86715-5596-4529-9b13-da13a5de5b63/ServiceTags_Public_20261109.json",
    );
    expect(() => findAzureFile("<html></html>")).toThrow("no ServiceTags_Public link");
    const text = JSON.stringify({
      values: [
        { name: "AzureFrontDoor.Frontend", properties: { addressPrefixes: ["192.0.2.0/24"] } },
        { name: "AzureCloud", properties: { addressPrefixes: ["203.0.113.0/24"] } },
      ],
    });
    expect(parseAzure(text)).toEqual(["203.0.113.0/24"]);
    expect(() => parseAzure(JSON.stringify({ values: [] }))).toThrow("no AzureCloud tag");
  });

  test("Oracle Cloud", () => {
    const text = JSON.stringify({
      regions: [
        { region: "a", cidrs: [{ cidr: "203.0.113.0/24", tags: ["OCI"] }] },
        { region: "b", cidrs: [{ cidr: "198.51.100.0/24", tags: ["OSN"] }] },
      ],
    });
    expect(parseOracle(text)).toEqual(["203.0.113.0/24", "198.51.100.0/24"]);
  });

  test("geofeeds (DigitalOcean, Akamai Cloud) and Vultr's JSON one", () => {
    const text = "# A geofeed\n\n203.0.113.0/24,NL,NL-NH,Amsterdam,\n2001:db8::/32,US,,,\n";
    expect(parseGeofeed(text)).toEqual(["203.0.113.0/24", "2001:db8::/32"]);
    expect(parseVultr(JSON.stringify({ subnets: [{ ip_prefix: "203.0.113.0/24" }] }))).toEqual([
      "203.0.113.0/24",
    ]);
  });

  test("a format change is an error, not an empty list", () => {
    expect(() => parseAws("<html>")).toThrow(SyntaxError);
    expect(() => parseGoogleCloud(JSON.stringify({ items: [] }))).toThrow(
      "expected prefixes to be an array",
    );
    expect(() => parseOracle(JSON.stringify({ regions: "x" }))).toThrow(
      "expected regions to be an array",
    );
  });
});

/** DB-IP's IP to ASN CSV: filler rows from other networks, then the given ones. */
function asnCsv(rows: string[]): string {
  const filler = Array.from(
    { length: 10_000 },
    (_, index) =>
      `10.${index >> 8}.${index & 255}.0,10.${index >> 8}.${index & 255}.255,64512,"Other"`,
  );
  return [...filler, ...rows].join("\n");
}

async function* linesOf(text: string) {
  yield* text.split("\n");
}

describe("rangesByNetwork", () => {
  test("collects each hosting network's ranges by its ASNs", async () => {
    const ranges = await rangesByNetwork(
      linesOf(
        asnCsv([
          '203.0.113.0,203.0.113.255,24940,"Hetzner Online GmbH"',
          '2001:db8::,2001:db8:ffff:ffff:ffff:ffff:ffff:ffff,213230,"Hetzner Online GmbH"',
          '198.51.100.0,198.51.100.255,16276,"OVH SAS"',
        ]),
      ),
      HOSTING_NETWORKS,
    );
    expect(ranges.get("hetzner")).toEqual([
      "203.0.113.0-203.0.113.255",
      "2001:db8::-2001:db8:ffff:ffff:ffff:ffff:ffff:ffff",
    ]);
    expect(ranges.get("ovhcloud")).toEqual(["198.51.100.0-198.51.100.255"]);
    expect(ranges.get("scaleway")).toEqual([]);
  });

  test("refuses a file far smaller than DB-IP's", async () => {
    await expect(
      rangesByNetwork(linesOf("1.0.0.0,1.0.0.255,13335,x"), HOSTING_NETWORKS),
    ).rejects.toThrow("not DB-IP's IP to ASN file");
  });
});

/** Five ranges for a provider: enough to count as a working source. */
const five = (third: number) =>
  Array.from({ length: 5 }, (_, index) => `203.0.${third}.${index * 16}/28`);

describe("downloadDataCenters", () => {
  const NOW = new Date("2026-11-17T12:00:00.000Z");
  const lists: Record<string, string> = {
    "https://ip-ranges.amazonaws.com/ip-ranges.json": JSON.stringify({
      prefixes: five(1).map((ip_prefix) => ({ ip_prefix, service: "EC2" })),
      ipv6_prefixes: [],
    }),
    "https://www.gstatic.com/ipranges/cloud.json": JSON.stringify({
      prefixes: five(2).map((ipv4Prefix) => ({ ipv4Prefix })),
    }),
    "https://www.microsoft.com/en-us/download/details.aspx?id=56519":
      '"https://download.microsoft.com/download/1/2/3/ServiceTags_Public_20261109.json"',
    "https://download.microsoft.com/download/1/2/3/ServiceTags_Public_20261109.json":
      JSON.stringify({
        values: [{ name: "AzureCloud", properties: { addressPrefixes: five(3) } }],
      }),
    "https://digitalocean.com/geo/google.csv": five(5).join(",NL,,,\n"),
    "https://geoip.linode.com/": five(6).join(",US,,,\n"),
    "https://geofeed.constant.com/?json": JSON.stringify({
      subnets: five(7).map((ip_prefix) => ({ ip_prefix })),
    }),
    // Oracle's list is missing: its source fails.
  };
  const asnRows = HOSTING_NETWORKS.flatMap((network, index) =>
    Array.from(
      { length: 5 },
      (_, row) =>
        `198.51.${index}.${row * 16},198.51.${index}.${row * 16 + 15},${network.asns[0]},"x"`,
    ),
  );

  const fetchText = async (url: string) => {
    const text = lists[url];
    if (text === undefined) throw new Error(`404 from ${url}`);
    return text;
  };
  const fetchStream = async (url: string) => {
    // Only last month's ASN file is out yet.
    if (!url.endsWith("dbip-asn-lite-2026-10.csv.gz")) throw new Error(`404 from ${url}`);
    return new Response(gzipSync(asnCsv(asnRows))).body!;
  };

  test("keeps a failed source's previous ranges, and says so", async () => {
    const previous: DataCenterFile = {
      version: 1,
      updatedAt: "2026-10-17T00:00:00.000Z",
      providers: [
        {
          id: "oracle-cloud",
          name: "Oracle Cloud",
          source: "https://docs.oracle.com/en-us/iaas/tools/public_ip_ranges.json",
          fetchedAt: "2026-10-17T00:00:00.000Z",
          ranges: five(4),
        },
      ],
    };
    const { file: downloaded, failures } = await downloadDataCenters({
      fetchText,
      fetchStream,
      previous,
      now: NOW,
    });

    expect(failures).toEqual([
      "oracle-cloud: 404 from https://docs.oracle.com/en-us/iaas/tools/public_ip_ranges.json (kept 2026-10-17T00:00:00.000Z)",
    ]);
    expect(downloaded.providers.map((provider) => provider.id)).toEqual([
      ...LIST_SOURCES.map((source) => source.id),
      ...HOSTING_NETWORKS.map((network) => network.id),
    ]);
    expect(downloaded.providers.find((provider) => provider.id === "oracle-cloud")).toEqual(
      previous.providers[0],
    );
    expect(downloaded.providers.find((provider) => provider.id === "hetzner")?.source).toBe(
      "https://download.db-ip.com/free/dbip-asn-lite-2026-10.csv.gz (AS24940, AS213230)",
    );

    const ranges = DataCenters.from(downloaded);
    expect(ranges.skipped).toBe(0);
    expect(ranges.has("203.0.1.20")).toBe(true); // AWS
    expect(ranges.has("203.0.4.20")).toBe(true); // Oracle, kept
    expect(ranges.has("198.51.0.20")).toBe(true); // Hetzner
    expect(ranges.has("192.0.2.1")).toBe(false);
  });

  test("a page of HTML in place of a list, or a download cut short, keeps the previous ranges", async () => {
    const previous = (await downloadDataCenters({ fetchText, fetchStream, now: NOW })).file;
    const html = Array.from({ length: 50 }, (_, line) => `<p>Line ${line}, maintenance</p>`);
    const { file: downloaded, failures } = await downloadDataCenters({
      fetchText: async (url) =>
        url === "https://digitalocean.com/geo/google.csv" ? html.join("\n") : fetchText(url),
      fetchStream: async () =>
        new ReadableStream<Uint8Array<ArrayBuffer>>({
          start(controller) {
            controller.enqueue(new Uint8Array(gzipSync(asnCsv(asnRows)).subarray(0, 1000)));
            controller.error(new Error("connection reset"));
          },
        }),
      previous,
      now: new Date("2026-12-17T12:00:00.000Z"),
    });

    expect(failures).toContain("digitalocean: only 0 valid ranges (kept 2026-11-17T12:00:00.000Z)");
    expect(failures).toContain("hetzner: connection reset (kept 2026-11-17T12:00:00.000Z)");
    const kept = (id: string) => downloaded.providers.find((provider) => provider.id === id);
    expect(kept("digitalocean")).toEqual(previous.providers.find((p) => p.id === "digitalocean"));
    expect(kept("hetzner")?.fetchedAt).toBe("2026-11-17T12:00:00.000Z");
    expect(kept("aws")?.fetchedAt).toBe("2026-12-17T12:00:00.000Z");
  });

  test("without a previous file, a failed source is left out", async () => {
    const { file: downloaded, failures } = await downloadDataCenters({
      fetchText,
      fetchStream: () => Promise.reject(new Error("offline")),
      now: NOW,
    });
    expect(failures).toHaveLength(1 + HOSTING_NETWORKS.length);
    expect(failures).toContain("hetzner: offline");
    expect(downloaded.providers.map((provider) => provider.id)).toEqual(
      LIST_SOURCES.map((source) => source.id).filter((id) => id !== "oracle-cloud"),
    );
  });
});

describe("setUpDataCenters", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ottertrail-data-centers-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("without the file, nothing is a data center, with a warning", async () => {
    const setup = await setUpDataCenters(join(dir, "missing.json"));
    expect(setup.ok).toBe(false);
    expect(setup.message).toContain("geo:update");
    expect(setup.isDataCenter("203.0.113.5")).toBe(false);
  });

  test("loads the file, and warns once its oldest ranges are stale", async () => {
    const path = join(dir, "data-centers.json");
    await writeFile(path, JSON.stringify(file(["203.0.113.0/24"], "2026-11-01T00:00:00.000Z")));

    const fresh = await setUpDataCenters(path, new Date("2026-11-17T00:00:00.000Z"));
    expect(fresh).toMatchObject({ ok: true });
    expect(fresh.isDataCenter("203.0.113.5")).toBe(true);

    const later = new Date(
      Date.parse("2026-11-01T00:00:00.000Z") + (DATA_CENTERS_STALE_AFTER_DAYS + 1) * 86_400_000,
    );
    const stale = await setUpDataCenters(path, later);
    expect(stale.ok).toBe(false);
    expect(stale.message).toContain("2026-11-01");
    expect(stale.isDataCenter("203.0.113.5")).toBe(true);
  });
});
