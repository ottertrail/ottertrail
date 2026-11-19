import {
  type DataCenterFile,
  type DataCenterProvider,
  isRecord,
  validRanges,
} from "./data-centers.ts";

/**
 * Where data-center ranges come from (docs/web-analytics.md, "Data
 * centers"). Providers that publish their own list are read from it: their
 * networks also carry traffic that is not their customers' servers, which a
 * list of the whole network would catch. Providers without a list are found
 * by their network numbers (ASNs) in DB-IP's IP to ASN Lite database (CC BY
 * 4.0), from the same supplier as the location database.
 */

/** Fetches a URL's text; throws on a network error or an unsuccessful status. */
export type FetchText = (url: string) => Promise<string>;

/** Fetches a URL's body as a stream of bytes. */
export type FetchStream = (url: string) => Promise<ReadableStream<Uint8Array<ArrayBuffer>>>;

interface ListSource {
  id: string;
  name: string;
  url: string;
  /** Finds the URL of the list itself, when it moves; given `url`'s text. */
  resolve?: (text: string) => string;
  /** The ranges in the list. Throws when it is not the expected format. */
  parse: (text: string) => string[];
}

function json(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error("expected a JSON object");
  return value;
}

function array(value: unknown, what: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`expected ${what} to be an array`);
  return value.filter(isRecord);
}

const strings = (values: unknown[]) =>
  values.filter((value): value is string => typeof value === "string");

/** A geofeed (RFC 8805): CSV lines "prefix,country,region,city,postal", "#" comments. */
export function parseGeofeed(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.split(",")[0]?.trim() ?? "")
    .filter((prefix) => prefix !== "");
}

const ec2 = (entries: Record<string, unknown>[]) =>
  entries.filter((entry) => entry.service === "EC2");

/** AWS's ip-ranges.json: the EC2 ranges, where customers' servers, Lambda, and containers run. */
export function parseAws(text: string): string[] {
  const file = json(text);
  return [
    ...strings(ec2(array(file.prefixes, "prefixes")).map((entry) => entry.ip_prefix)),
    ...strings(ec2(array(file.ipv6_prefixes, "ipv6_prefixes")).map((entry) => entry.ipv6_prefix)),
  ];
}

/** Google's cloud.json: the addresses Google Cloud customers use. */
export function parseGoogleCloud(text: string): string[] {
  return strings(
    array(json(text).prefixes, "prefixes").map((entry) => entry.ipv4Prefix ?? entry.ipv6Prefix),
  );
}

/** The current weekly Service Tags file, linked from Microsoft's download page. */
export function findAzureFile(page: string): string {
  const match =
    /https:\/\/download\.microsoft\.com\/download\/[\w./-]+\/ServiceTags_Public_\d{8}\.json/.exec(
      page,
    );
  if (match === null) throw new Error("no ServiceTags_Public link on the download page");
  return match[0];
}

/** Azure's Service Tags: the "AzureCloud" tag, every public address of Azure. */
export function parseAzure(text: string): string[] {
  const tag = array(json(text).values, "values").find((value) => value.name === "AzureCloud");
  if (tag === undefined || !isRecord(tag.properties)) throw new Error("no AzureCloud tag");
  const prefixes = tag.properties.addressPrefixes;
  if (!Array.isArray(prefixes)) throw new Error("AzureCloud has no addressPrefixes");
  return strings(prefixes);
}

/** Oracle Cloud's public_ip_ranges.json. */
export function parseOracle(text: string): string[] {
  return array(json(text).regions, "regions").flatMap((region) =>
    strings(array(region.cidrs, "cidrs").map((entry) => entry.cidr)),
  );
}

/** Vultr's geofeed, as JSON. */
export function parseVultr(text: string): string[] {
  return strings(array(json(text).subnets, "subnets").map((subnet) => subnet.ip_prefix));
}

export const LIST_SOURCES: ListSource[] = [
  {
    id: "aws",
    name: "Amazon Web Services (EC2)",
    url: "https://ip-ranges.amazonaws.com/ip-ranges.json",
    parse: parseAws,
  },
  {
    id: "google-cloud",
    name: "Google Cloud",
    url: "https://www.gstatic.com/ipranges/cloud.json",
    parse: parseGoogleCloud,
  },
  {
    id: "azure",
    name: "Microsoft Azure",
    url: "https://www.microsoft.com/en-us/download/details.aspx?id=56519",
    resolve: findAzureFile,
    parse: parseAzure,
  },
  {
    id: "oracle-cloud",
    name: "Oracle Cloud",
    url: "https://docs.oracle.com/en-us/iaas/tools/public_ip_ranges.json",
    parse: parseOracle,
  },
  {
    id: "digitalocean",
    name: "DigitalOcean",
    url: "https://digitalocean.com/geo/google.csv",
    parse: parseGeofeed,
  },
  {
    id: "akamai-linode",
    name: "Akamai Cloud (Linode)",
    url: "https://geoip.linode.com/",
    parse: parseGeofeed,
  },
  {
    id: "vultr",
    name: "Vultr",
    url: "https://geofeed.constant.com/?json",
    parse: parseVultr,
  },
];

/**
 * Hosting providers without a published list, by the network numbers
 * their servers' addresses are announced from. Each was checked against
 * the network's registered holder (RIPE, APNIC, ARIN) in November 2026.
 * Only networks that host servers belong here: not an ISP's, and not a
 * CDN's, whose addresses iCloud Private Relay and VPNs use for real people.
 */
export const HOSTING_NETWORKS: { id: string; name: string; asns: number[] }[] = [
  { id: "hetzner", name: "Hetzner", asns: [24940, 213230] },
  { id: "ovhcloud", name: "OVHcloud", asns: [16276] },
  { id: "scaleway", name: "Scaleway", asns: [12876] },
  { id: "contabo", name: "Contabo", asns: [51167, 40021, 141995] },
  { id: "alibaba-cloud", name: "Alibaba Cloud", asns: [45102, 37963] },
  { id: "tencent-cloud", name: "Tencent Cloud", asns: [132203] },
  { id: "huawei-cloud", name: "Huawei Cloud", asns: [136907] },
];

/** "2026-11" for offset 0, the previous month for offset 1. */
export function yearMonth(offset: number, now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1))
    .toISOString()
    .slice(0, 7);
}

export const asnDatabaseUrl = (month: string) =>
  `https://download.db-ip.com/free/dbip-asn-lite-${month}.csv.gz`;

/**
 * The ranges of each hosting network, from DB-IP's IP to ASN Lite CSV:
 * lines of `start,end,asn,"organization"`.
 */
export async function rangesByNetwork(
  lines: AsyncIterable<string>,
  networks: typeof HOSTING_NETWORKS,
): Promise<Map<string, string[]>> {
  const providerOf = new Map<number, string>();
  for (const network of networks) {
    for (const asn of network.asns) providerOf.set(asn, network.id);
  }
  const ranges = new Map(networks.map((network) => [network.id, [] as string[]]));
  let rows = 0;
  for await (const line of lines) {
    const [start, end, asn] = line.split(",", 3);
    if (start === undefined || end === undefined || asn === undefined) continue;
    rows += 1;
    const provider = providerOf.get(Number(asn));
    if (provider !== undefined) ranges.get(provider)?.push(`${start}-${end}`);
  }
  // The whole file has hundreds of thousands of rows: far fewer means it is
  // not the file we expect.
  if (rows < 10_000) throw new Error(`only ${rows} rows: not DB-IP's IP to ASN file`);
  return ranges;
}

/**
 * The lines of a gzipped text stream. A failed download or a corrupt file
 * rejects the loop that reads them, and stopping early cancels the download.
 * A line longer than `maxLineLength` rejects it too: DB-IP's lines are
 * short, and a stream without line breaks must not fill the memory.
 */
export async function* gunzippedLines(
  stream: ReadableStream<Uint8Array<ArrayBuffer>>,
  maxLineLength: number = 64 * 1024,
): AsyncGenerator<string> {
  const reader = stream
    .pipeThrough(new DecompressionStream("gzip"))
    .pipeThrough(new TextDecoderStream())
    .getReader();
  let rest = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = (rest + value).split("\n");
      rest = lines.pop() ?? "";
      if (rest.length > maxLineLength || lines.some((line) => line.length > maxLineLength)) {
        throw new Error(`a line longer than ${maxLineLength} characters: not DB-IP's file`);
      }
      yield* lines;
    }
    if (rest !== "") yield rest;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Fewer ranges than this from one source means its format changed, or it failed. */
const MIN_RANGES = 5;

export interface DataCenterDownload {
  file: DataCenterFile;
  /** One line per source that failed; its previous ranges, if any, were kept. */
  failures: string[];
}

/**
 * Downloads every source. A source that fails keeps its ranges from
 * `previous`, with their old date, so one provider's outage or format
 * change does not drop the others' or its own.
 */
export async function downloadDataCenters(options: {
  fetchText: FetchText;
  fetchStream: FetchStream;
  previous?: DataCenterFile | undefined;
  now?: Date;
  /** The longest line DB-IP's ASN file may have (gunzippedLines). */
  maxLineLength?: number;
}): Promise<DataCenterDownload> {
  const now = options.now ?? new Date();
  const fetchedAt = now.toISOString();
  const previous = new Map(options.previous?.providers.map((provider) => [provider.id, provider]));
  const providers: DataCenterProvider[] = [];
  const failures: string[] = [];

  function keepPrevious(id: string, reason: string) {
    const kept = previous.get(id);
    failures.push(`${id}: ${reason}${kept === undefined ? "" : ` (kept ${kept.fetchedAt})`}`);
    if (kept !== undefined) providers.push(kept);
  }

  for (const source of LIST_SOURCES) {
    try {
      let url = source.url;
      if (source.resolve !== undefined) url = source.resolve(await options.fetchText(url));
      // Only well-formed ranges count: a page of HTML instead of the list
      // must fail here, and keep the previous ranges.
      const ranges = validRanges([...new Set(source.parse(await options.fetchText(url)))]);
      if (ranges.length < MIN_RANGES) throw new Error(`only ${ranges.length} valid ranges`);
      providers.push({ id: source.id, name: source.name, source: url, fetchedAt, ranges });
    } catch (error) {
      keepPrevious(source.id, error instanceof Error ? error.message : String(error));
    }
  }

  let networks: Map<string, string[]> | undefined;
  let networkSource = "";
  let networkError = "not available for this month or last month";
  // A new file is published early each month: before it is, last month's.
  for (const offset of [0, 1]) {
    const url = asnDatabaseUrl(yearMonth(offset, now));
    try {
      networks = await rangesByNetwork(
        gunzippedLines(await options.fetchStream(url), options.maxLineLength),
        HOSTING_NETWORKS,
      );
      networkSource = url;
      break;
    } catch (error) {
      networkError = error instanceof Error ? error.message : String(error);
    }
  }
  for (const network of HOSTING_NETWORKS) {
    const found = networks?.get(network.id);
    const ranges = found === undefined ? undefined : validRanges(found);
    if (ranges === undefined || ranges.length < MIN_RANGES) {
      keepPrevious(
        network.id,
        ranges === undefined ? networkError : `only ${ranges.length} valid ranges`,
      );
      continue;
    }
    providers.push({
      id: network.id,
      name: network.name,
      source: `${networkSource} (AS${network.asns.join(", AS")})`,
      fetchedAt,
      ranges,
    });
  }

  return { file: { version: 1, updatedAt: fetchedAt, providers }, failures };
}
