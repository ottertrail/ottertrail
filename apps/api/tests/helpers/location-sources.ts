import { gzipSync } from "node:zlib";

import { asnDatabaseUrl, HOSTING_NETWORKS } from "../../src/enrichment/data-center-sources.ts";
import { type Fetch, locationsUrl } from "../../src/enrichment/updates.ts";
import { fakeMmdb } from "./mmdb.ts";

/** Five ranges for a provider: enough to count as a working source. */
const five = (third: number) =>
  Array.from({ length: 5 }, (_, index) => `203.0.${third}.${index * 16}/28`);

/** Every provider's list, in its format, as data-center-sources.ts reads them. */
export const PROVIDER_LISTS: Record<string, string> = {
  "https://ip-ranges.amazonaws.com/ip-ranges.json": JSON.stringify({
    prefixes: five(1).map((ip_prefix) => ({ ip_prefix, service: "EC2" })),
    ipv6_prefixes: [],
  }),
  "https://www.gstatic.com/ipranges/cloud.json": JSON.stringify({
    prefixes: five(2).map((ipv4Prefix) => ({ ipv4Prefix })),
  }),
  "https://www.microsoft.com/en-us/download/details.aspx?id=56519":
    '"https://download.microsoft.com/download/1/2/3/ServiceTags_Public_20261109.json"',
  "https://download.microsoft.com/download/1/2/3/ServiceTags_Public_20261109.json": JSON.stringify({
    values: [{ name: "AzureCloud", properties: { addressPrefixes: five(3) } }],
  }),
  "https://docs.oracle.com/en-us/iaas/tools/public_ip_ranges.json": JSON.stringify({
    regions: [{ cidrs: five(4).map((cidr) => ({ cidr })) }],
  }),
  "https://digitalocean.com/geo/google.csv": five(5).join(",NL,,,\n"),
  "https://geoip.linode.com/": five(6).join(",US,,,\n"),
  "https://geofeed.constant.com/?json": JSON.stringify({
    subnets: five(7).map((ip_prefix) => ({ ip_prefix })),
  }),
};

/** DB-IP's IP to ASN file, gzipped: filler rows, then five ranges per hosting network. */
export function asnFile(): Buffer {
  const filler = Array.from(
    { length: 10_000 },
    (_, index) =>
      `10.${index >> 8}.${index & 255}.0,10.${index >> 8}.${index & 255}.255,64512,"Other"`,
  );
  const rows = HOSTING_NETWORKS.flatMap((network, index) =>
    Array.from(
      { length: 5 },
      (_, row) =>
        `198.51.${index}.${row * 16},198.51.${index}.${row * 16 + 15},${network.asns[0]},"x"`,
    ),
  );
  return gzipSync([...filler, ...rows].join("\n"));
}

/** A location file of one month, gzipped as DB-IP serves it. */
export const locationFile = (options: Parameters<typeof fakeMmdb>[0] = {}) =>
  gzipSync(fakeMmdb(options));

/** A redirect the fake answers with. */
export interface Redirect {
  redirect: string;
}

/**
 * A body in 16 KB chunks, as a download arrives: an aborted signal fails
 * it between chunks, as fetch()'s body does.
 */
function streamOf(
  body: string | Buffer,
  signal: AbortSignal | undefined,
): ReadableStream<Uint8Array> {
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (signal?.aborted === true) {
        controller.error(signal.reason);
        return;
      }
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(bytes.subarray(offset, offset + 16_384)));
      offset += 16_384;
    },
  });
}

/**
 * A fetch() that never leaves the process: it answers the URLs in `files`
 * (a body, or a redirect), and 404 to anything else, and records every URL
 * asked for. As fetch(), it follows redirects itself unless asked for
 * `redirect: "manual"`, and an aborted signal rejects it, or fails its
 * body while it is read.
 */
export function fakeFetch(
  files: Record<string, string | Buffer | Redirect>,
): Fetch & { urls: string[] } {
  const urls: string[] = [];
  const fetchFake: Fetch = async (url, init) => {
    urls.push(url);
    init?.signal?.throwIfAborted();
    const body = files[url];
    if (body === undefined) return new Response("Not found", { status: 404 });
    if (typeof body === "object" && "redirect" in body) {
      if (init?.redirect !== "manual") {
        return fetchFake(new URL(body.redirect, url).toString(), init);
      }
      return new Response(null, { status: 302, headers: { location: body.redirect } });
    }
    return new Response(streamOf(body, init?.signal));
  };
  return Object.assign(fetchFake, { urls });
}

/** Every source of one month: the location file, the ASN file, and the providers' lists. */
export function allSources(month: string, location: Buffer = locationFile()) {
  return { [locationsUrl(month)]: location, [asnDatabaseUrl(month)]: asnFile(), ...PROVIDER_LISTS };
}

/** A server that never answers: the request ends only when its signal aborts. */
export const hangingFetch: Fetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
