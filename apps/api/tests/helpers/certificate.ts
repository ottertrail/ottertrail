import { Buffer } from "node:buffer";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";

/**
 * A self-signed TLS certificate made at run time for the tests' HTTPS
 * servers, so none is kept in the repository: an ECDSA P-256 key, and an
 * X.509 v3 certificate for the given names and IPv4 addresses, encoded by
 * hand in DER (node:crypto signs, but makes no certificates).
 */
export interface TestCertificate {
  /** PEM, for the server's `cert` and a client's `ca`. */
  cert: string;
  /** PEM (PKCS #8), for the server. */
  privateKey: string;
  notAfter: Date;
}

function length(size: number): number[] {
  if (size < 0x80) return [size];
  const bytes: number[] = [];
  for (let rest = size; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return [0x80 | bytes.length, ...bytes];
}

const tlv = (tag: number, content: Buffer | number[]) => {
  const body = Buffer.from(content);
  return Buffer.concat([Buffer.from([tag, ...length(body.length)]), body]);
};
const sequence = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));

function oid(text: string): Buffer {
  const [first = 0, second = 0, ...rest] = text.split(".").map(Number);
  const bytes = [first * 40 + second];
  for (const part of rest) {
    const groups: number[] = [];
    for (let value = part; ; value = Math.floor(value / 128)) {
      groups.unshift(value % 128);
      if (value < 128) break;
    }
    bytes.push(...groups.map((group, index) => (index < groups.length - 1 ? group | 0x80 : group)));
  }
  return tlv(0x06, bytes);
}

/** UTCTime, as certificates write times before 2050. */
function utcTime(moment: Date): Buffer {
  const iso = moment.toISOString();
  const text = `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return tlv(0x17, Buffer.from(text, "ascii"));
}

const ECDSA_WITH_SHA256 = "1.2.840.10045.4.3.2";

export function makeCertificate({
  names = ["localhost"],
  addresses = ["127.0.0.1"],
  notBefore = new Date(Date.now() - 86_400_000),
  notAfter = new Date("2030-06-15T12:00:00.000Z"),
}: {
  names?: string[];
  addresses?: string[];
  notBefore?: Date;
  notAfter?: Date;
} = {}): TestCertificate {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const subject = sequence(
    set(sequence(oid("2.5.4.3"), tlv(0x0c, Buffer.from("Ottertrail test", "utf8")))),
  );
  const serial = randomBytes(8);
  serial[0] = (serial[0] ?? 0) & 0x7f;
  const altNames = sequence(
    ...names.map((name) => tlv(0x82, Buffer.from(name, "ascii"))),
    ...addresses.map((address) => tlv(0x87, address.split(".").map(Number))),
  );
  const extensions = tlv(
    0xa3,
    sequence(
      // basicConstraints, critical: a CA, so a client can trust it as its own root.
      sequence(oid("2.5.29.19"), tlv(0x01, [0xff]), tlv(0x04, sequence(tlv(0x01, [0xff])))),
      sequence(oid("2.5.29.17"), tlv(0x04, altNames)),
    ),
  );
  const tbs = sequence(
    tlv(0xa0, tlv(0x02, [2])),
    tlv(0x02, serial),
    sequence(oid(ECDSA_WITH_SHA256)),
    subject,
    sequence(utcTime(notBefore), utcTime(notAfter)),
    subject,
    publicKey.export({ type: "spki", format: "der" }),
    extensions,
  );
  const signature = sign("sha256", tbs, privateKey);
  const der = sequence(
    tbs,
    sequence(oid(ECDSA_WITH_SHA256)),
    tlv(0x03, Buffer.concat([Buffer.from([0]), signature])),
  );
  const base64 = der.toString("base64").replace(/(.{64})/g, "$1\n");
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${base64.trimEnd()}\n-----END CERTIFICATE-----\n`,
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
    notAfter,
  };
}
