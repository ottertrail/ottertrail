/**
 * Avoid DB-IP's 130 MB download with a one-node MaxMind DB format 2.0 file.
 * Every address maps to one location. An IPv6 tree also answers IPv4 queries.
 */

/** A control byte and, for types above 7, the extended type byte. */
function control(type: number, size: number): number[] {
  if (size >= 29) throw new Error("fake MMDB values must be short");
  return type <= 7 ? [(type << 5) | size] : [size, type - 7];
}

function encode(value: unknown): number[] {
  if (typeof value === "string") {
    const bytes = [...Buffer.from(value, "utf8")];
    return [...control(2, bytes.length), ...bytes];
  }
  if (typeof value === "number") {
    // uint32 (type 6), big-endian, as few bytes as needed.
    const bytes: number[] = [];
    for (let rest = value; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
    return [...control(6, bytes.length), ...bytes];
  }
  if (typeof value === "bigint") {
    // uint64 (type 9).
    const bytes: number[] = [];
    for (let rest = value; rest > 0n; rest >>= 8n) bytes.unshift(Number(rest & 255n));
    return [...control(9, bytes.length), ...bytes];
  }
  if (Array.isArray(value)) {
    return [...control(11, value.length), ...value.flatMap(encode)];
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    return [
      ...control(7, entries.length),
      ...entries.flatMap(([key, item]) => [...encode(key), ...encode(item)]),
    ];
  }
  throw new Error(`cannot encode ${String(value)}`);
}

/**
 * "DBIP-City-Lite" passes the updater's type check.
 */
export function fakeMmdb({
  type = "DBIP-City-Lite",
  country = "US",
  city = "Mountain View",
  builtAt = new Date("2026-11-01T02:52:26.000Z"),
  ipVersion = 4,
}: {
  type?: string;
  country?: string;
  city?: string;
  builtAt?: Date;
  ipVersion?: 4 | 6;
} = {}): Buffer {
  const nodeCount = 1;
  // Both records of the one node: the data record at offset 0 of the data section.
  const pointer = nodeCount + 16;
  const record = [(pointer >> 16) & 255, (pointer >> 8) & 255, pointer & 255];
  const tree = [...record, ...record];
  const data = encode({ country: { iso_code: country }, city: { names: { en: city } } });
  const metadata = encode({
    node_count: nodeCount,
    record_size: 24,
    ip_version: ipVersion,
    database_type: type,
    languages: ["en"],
    binary_format_major_version: 2,
    binary_format_minor_version: 0,
    build_epoch: BigInt(Math.floor(builtAt.getTime() / 1000)),
    description: { en: "A test database" },
  });
  return Buffer.from([
    ...tree,
    ...Array<number>(16).fill(0),
    ...data,
    ...Buffer.from("abcdef4d61784d696e642e636f6d", "hex"),
    ...metadata,
  ]);
}
