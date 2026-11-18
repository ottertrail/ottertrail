import { describe, expect, test } from "vite-plus/test";

import {
  type AddressKind,
  addressKind,
  AddressNotAllowedError,
  embeddedIpv4,
  type Lookup,
  addressPolicy,
  METADATA_ADDRESSES,
  refusedKind,
  resolveTarget,
} from "../src/outbound/addresses.ts";

const CLOSED = { allowPrivate: false };
const OPEN = { allowPrivate: true };

/** A resolver that answers from a table, and counts its calls. */
function fakeLookup(table: Record<string, string[]>): Lookup & { calls: string[] } {
  const calls: string[] = [];
  const lookup = async (hostname: string) => {
    calls.push(hostname);
    const addresses = table[hostname];
    if (addresses === undefined) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    }
    return addresses.map(
      (address) => ({ address, family: address.includes(":") ? 6 : 4 }) as const,
    );
  };
  return Object.assign(lookup, { calls });
}

describe("addressKind", () => {
  const cases: [string, AddressKind | null][] = [
    // IPv4, every refused range, at its edges.
    ["0.0.0.0", "unspecified"],
    ["0.255.255.255", "unspecified"],
    ["10.0.0.1", "private"],
    ["10.255.255.255", "private"],
    ["100.64.0.1", "shared"],
    ["100.127.255.254", "shared"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.255", "loopback"],
    ["169.254.169.254", "link-local"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.1", "private"],
    ["192.0.0.8", "reserved"],
    ["192.0.2.10", "reserved"],
    ["192.88.99.1", "reserved"],
    ["198.18.0.1", "reserved"],
    ["198.19.255.255", "reserved"],
    ["198.51.100.7", "reserved"],
    ["203.0.113.9", "reserved"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.250", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "reserved"],
    // IPv4 neighbours that are public.
    ["100.63.255.255", null],
    ["100.128.0.0", null],
    ["172.15.255.255", null],
    ["172.32.0.0", null],
    ["198.17.255.255", null],
    ["93.184.215.14", null],
    ["8.8.8.8", null],
    // IPv6.
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["fc00::1", "unique-local"],
    ["fd12:3456:789a::1", "unique-local"],
    ["fe80::1", "link-local"],
    ["fe80::1%en0", "link-local"],
    ["febf::1", "link-local"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "reserved"],
    ["2001::1", "reserved"],
    ["3fff::1", "reserved"],
    ["100::1", "reserved"],
    ["fec0::1", "reserved"],
    ["::2", "reserved"],
    ["64:ff9b:1::a00:1", "private"],
    ["2606:4700:4700::1111", null],
    ["2a00:1450:4001:80b::200e", null],
    // IPv4-mapped: the IPv4 address inside decides.
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:7f00:1", "loopback"],
    ["::ffff:10.1.2.3", "private"],
    ["::ffff:169.254.169.254", "link-local"],
    ["::ffff:100.64.0.1", "shared"],
    ["::ffff:0.0.0.0", "unspecified"],
    ["::ffff:224.0.0.1", "multicast"],
    ["::ffff:8.8.8.8", null],
    // NAT64's well-known prefix.
    ["64:ff9b::127.0.0.1", "loopback"],
    ["64:ff9b::a9fe:a9fe", "link-local"],
    ["64:ff9b::c0a8:101", "private"],
    ["64:ff9b::808:808", null],
    // 6to4.
    ["2002:7f00:1::", "loopback"],
    ["2002:a00:1::1", "private"],
    ["2002:808:808::1", null],
    // Brackets, as a URL's host has them.
    ["[::1]", "loopback"],
    // Not an address at all.
    ["not-an-ip", "reserved"],
  ];
  test.each(cases)("%s is %s", (address, kind) => {
    expect(addressKind(address)).toBe(kind);
  });

  test("reads the IPv4 address inside mapped, NAT64, and 6to4 addresses", () => {
    expect(embeddedIpv4("::ffff:192.168.0.1")).toBe("192.168.0.1");
    expect(embeddedIpv4("::ffff:c0a8:1")).toBe("192.168.0.1");
    expect(embeddedIpv4("64:ff9b::c0a8:1")).toBe("192.168.0.1");
    expect(embeddedIpv4("2002:c0a8:1::")).toBe("192.168.0.1");
    expect(embeddedIpv4("2606:4700::1")).toBeNull();
  });

  test("the private-address setting lets loopback, private, unique-local, and shared through, nothing else", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "192.168.1.1",
      "100.64.0.1",
      "fd00::1",
      "::1",
    ]) {
      expect(refusedKind(address, CLOSED)).not.toBeNull();
      expect(refusedKind(address, OPEN)).toBeNull();
    }
    for (const address of [
      "169.254.169.254",
      "fe80::1",
      "224.0.0.1",
      "0.0.0.0",
      "::",
      "240.0.0.1",
      "::ffff:169.254.169.254",
    ]) {
      expect(refusedKind(address, OPEN)).not.toBeNull();
    }
  });
});

describe("resolveTarget", () => {
  test("answers with the first address of a public host", async () => {
    const lookup = fakeLookup({
      "example.com": ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"],
    });
    await expect(
      resolveTarget(new URL("https://example.com/health"), { lookup, policy: CLOSED }),
    ).resolves.toEqual({ address: "93.184.215.14", family: 4 });
  });

  test("refuses a host when any of its addresses is private, even beside public ones", async () => {
    const lookup = fakeLookup({ "mixed.example": ["93.184.215.14", "10.0.0.5"] });
    const refused = await resolveTarget(new URL("http://mixed.example/"), {
      lookup,
      policy: CLOSED,
    }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AddressNotAllowedError);
    expect(refused).toMatchObject({ kind: "private", address: "10.0.0.5", host: "mixed.example" });
    expect(refused).toMatchObject({
      // Neither the address nor its kind: a member learns nothing of the network behind.
      message: "mixed.example resolves to an address checks may not reach.",
    });
  });

  test("refuses mapped and NAT64 answers by the IPv4 address inside", async () => {
    const lookup = fakeLookup({
      "mapped.example": ["::ffff:169.254.169.254"],
      "nat64.example": ["64:ff9b::7f00:1"],
    });
    await expect(
      resolveTarget(new URL("http://mapped.example/"), { lookup, policy: OPEN }),
    ).rejects.toMatchObject({
      message: "mapped.example resolves to an address checks may not reach.",
      address: "::ffff:169.254.169.254",
      kind: "metadata",
    });
    await expect(
      resolveTarget(new URL("http://nat64.example/"), { lookup, policy: CLOSED }),
    ).rejects.toMatchObject({ kind: "loopback" });
  });

  test("checks an IP address in the URL without resolving", async () => {
    const lookup = fakeLookup({});
    await expect(
      resolveTarget(new URL("http://[::1]:8080/"), { lookup, policy: CLOSED }),
    ).rejects.toThrow("::1 is a loopback address: checks may not reach it.");
    // The URL parser reads other spellings of an IPv4 address as the address.
    await expect(
      resolveTarget(new URL("http://2130706433/"), { lookup, policy: CLOSED }),
    ).rejects.toMatchObject({ kind: "loopback", address: "127.0.0.1" });
    await expect(
      resolveTarget(new URL("http://0x7f.1/"), { lookup, policy: CLOSED }),
    ).rejects.toMatchObject({ kind: "loopback" });
    expect(lookup.calls).toEqual([]);
  });

  test("refuses localhost by what it resolves to", async () => {
    const lookup = fakeLookup({ localhost: ["127.0.0.1", "::1"] });
    await expect(
      resolveTarget(new URL("http://localhost:5432/"), { lookup, policy: CLOSED }),
    ).rejects.toMatchObject({ kind: "loopback" });
  });

  test("passes a resolver's failure on, and refuses an empty answer", async () => {
    const lookup = fakeLookup({ "empty.example": [] });
    await expect(
      resolveTarget(new URL("http://missing.example/"), { lookup, policy: CLOSED }),
    ).rejects.toMatchObject({ code: "ENOTFOUND" });
    await expect(
      resolveTarget(new URL("http://empty.example/"), { lookup, policy: CLOSED }),
    ).rejects.toMatchObject({ code: "ENOTFOUND" });
  });
});

describe("addresses no setting lets through", () => {
  test("cloud metadata services, inside and outside link-local, and in their IPv4-mapped forms", () => {
    for (const address of [
      ...METADATA_ADDRESSES,
      "::ffff:100.100.100.200",
      "::ffff:6464:64c8",
      "64:ff9b::6464:64c8",
    ]) {
      expect([address, refusedKind(address, OPEN)]).toEqual([address, "metadata"]);
    }
    // Their neighbours are only what their range makes them.
    expect(refusedKind("100.100.100.201", OPEN)).toBeNull();
    expect(refusedKind("fd00:ec2::253", OPEN)).toBeNull();
    expect(refusedKind("fd20:ce::253", CLOSED)).toBe("unique-local");
  });

  test("names a metadata address the member typed, and its kind", async () => {
    await expect(
      resolveTarget(new URL("http://[fd00:ec2::254]/latest/meta-data/"), {
        lookup: fakeLookup({}),
        policy: OPEN,
      }),
    ).rejects.toThrow(
      "fd00:ec2::254 is a cloud metadata service's address: checks may not reach it.",
    );
    await expect(
      resolveTarget(new URL("http://[::ffff:100.100.100.200]/"), {
        lookup: fakeLookup({}),
        policy: OPEN,
      }),
    ).rejects.toThrow(
      "::ffff:6464:64c8 is an IPv6 form of 100.100.100.200, a cloud metadata service's address",
    );
  });

  test("UPTIME_DENY_ADDRESSES: addresses and ranges refused even when public or allowed", async () => {
    const policy = addressPolicy({
      allowPrivate: true,
      deny: ["203.0.114.7", "198.51.99.0/24", "2a01:4f8:c0c::/48", "10.1.0.0/16"],
    });
    expect(refusedKind("203.0.114.7", policy)).toBe("denied");
    expect(refusedKind("::ffff:203.0.114.7", policy)).toBe("denied");
    expect(refusedKind("198.51.99.200", policy)).toBe("denied");
    expect(refusedKind("2a01:4f8:c0c:1::1", policy)).toBe("denied");
    expect(refusedKind("10.1.2.3", policy)).toBe("denied");
    // Other private addresses stay allowed by the setting.
    expect(refusedKind("10.2.0.1", policy)).toBeNull();
    expect(refusedKind("203.0.114.8", policy)).toBeNull();
    await expect(
      resolveTarget(new URL("http://own.example:8080/"), {
        lookup: fakeLookup({ "own.example": ["203.0.114.7"] }),
        policy,
      }),
    ).rejects.toMatchObject({
      message: "own.example resolves to an address checks may not reach.",
      kind: "denied",
    });
    expect(() => addressPolicy({ allowPrivate: false, deny: ["10.0.0.0/33"] })).toThrow(
      'Not an address or CIDR range: "10.0.0.0/33"',
    );
  });
});
