import { createHash } from "node:crypto";

import { Decrypter, Encrypter } from "age-encryption";

/**
 * The bytes of a backup's parts on their way to the destination and back
 * (docs/deployment.md, "Backups"): counted and hashed with SHA-256 before
 * and after encryption, encrypted with age to the backup key's recipient,
 * all as streams, so a large file is never held whole in memory.
 *
 * age (https://age-encryption.org/v1) is a standard format: a part
 * decrypts with the `age` command (`age -d -i key.txt part.age`) as well
 * as with Ottertrail. The library is typage (`age-encryption` on npm), by
 * age's own author.
 */

/** A part's size and SHA-256, before or after encryption. */
export interface Digest {
  bytes: number;
  sha256: string;
}

/** Passes `source` through, counting and hashing it; `digest()` once it has ended. */
export function measured(source: AsyncIterable<Uint8Array>): {
  stream: AsyncIterable<Uint8Array>;
  digest: () => Digest;
} {
  const hash = createHash("sha256");
  let bytes = 0;
  let ended = false;
  let sum = "";
  async function* pass() {
    for await (const chunk of source) {
      hash.update(chunk);
      bytes += chunk.length;
      yield chunk;
    }
    sum = hash.digest("hex");
    ended = true;
  }
  return {
    stream: pass(),
    digest: () => {
      if (!ended) throw new Error("the stream has not ended");
      return { bytes, sha256: sum };
    },
  };
}

const toWeb = (source: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> =>
  ReadableStream.from(source);

async function* fromWeb(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  yield* stream;
}

/** `source` encrypted to `recipient` ("age1…"), as an age file. */
export async function encrypted(
  source: AsyncIterable<Uint8Array>,
  recipient: string,
): Promise<AsyncIterable<Uint8Array>> {
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  return fromWeb(await encrypter.encrypt(toWeb(source)));
}

/** An age file decrypted with `identity` ("AGE-SECRET-KEY-1…"); throws when it is not for it. */
export async function decrypted(
  source: AsyncIterable<Uint8Array>,
  identity: string,
): Promise<AsyncIterable<Uint8Array>> {
  const decrypter = new Decrypter();
  decrypter.addIdentity(identity);
  return fromWeb(await decrypter.decrypt(toWeb(source)));
}

/** One file in a tar: its name, its size, and its bytes, exactly `size` of them. */
export interface TarEntry {
  name: string;
  size: number;
  body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
}

const BLOCK = 512;
/** A ustar size field holds 11 octal digits: up to 8 GiB less a byte. */
const MAX_TAR_SIZE = 8 * 1024 ** 3 - 1;

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

/** A ustar header for a regular file (type "0") or a folder ("5"). */
export function tarHeader(name: string, size: number, type: "0" | "5", mtime: Date): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error(`tar name too long: ${name}`);
  if (size > MAX_TAR_SIZE) throw new Error(`${name} is larger than a tar entry holds`);
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 100, "utf8");
  header.write(octal(type === "5" ? 0o700 : 0o600, 8), 100, "ascii");
  header.write(octal(0, 8), 108, "ascii");
  header.write(octal(0, 8), 116, "ascii");
  header.write(octal(size, 12), 124, "ascii");
  header.write(octal(Math.floor(mtime.getTime() / 1000), 12), 136, "ascii");
  header.write("        ", 148, "ascii");
  header.write(type, 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return header;
}

/**
 * A tar archive, as `tar -xf` unpacks it: a folder entry for each name
 * in `folders`, then each file, padded to whole blocks, then the two
 * empty blocks that end it. A body that gives more or fewer bytes than
 * its size fails the archive.
 */
export async function* tarStream(
  folders: readonly string[],
  entries: AsyncIterable<TarEntry>,
  mtime: Date = new Date(),
): AsyncIterable<Uint8Array> {
  for (const folder of folders) yield tarHeader(`${folder}/`, 0, "5", mtime);
  for await (const entry of entries) {
    yield tarHeader(entry.name, entry.size, "0", mtime);
    let written = 0;
    for await (const chunk of entry.body) {
      written += chunk.length;
      if (written > entry.size) throw new Error(`${entry.name} is longer than ${entry.size} bytes`);
      yield chunk;
    }
    if (written !== entry.size) {
      throw new Error(`${entry.name} ended after ${written} of ${entry.size} bytes`);
    }
    const pad = (BLOCK - (entry.size % BLOCK)) % BLOCK;
    if (pad > 0) yield Buffer.alloc(pad);
  }
  yield Buffer.alloc(BLOCK * 2);
}
