import { crc32, deflateSync } from "node:zlib";

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * Override `claimed` to make the IHDR dimensions differ from the pixels.
 */
export function png(
  width: number,
  height: number,
  claimed: { width: number; height: number } = { width, height },
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(claimed.width, 0);
  header.writeUInt32BE(claimed.height, 4);
  // 8-bit greyscale, no interlace.
  header.writeUInt8(8, 8);
  header.writeUInt8(0, 9);
  const rows = Buffer.alloc((width + 1) * height, 0x80);
  for (let row = 0; row < height; row += 1) rows[row * (width + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Only enough ICO data for the magic-byte check. */
export const ICO = Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), Buffer.alloc(32, 1)]);

export const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><script>alert(1)</script></svg>',
);

/** A JPEG's first bytes, `width`×`height`, its frame after an APP0 segment. */
export function jpeg(width: number, height: number, frame = 0xc0): Buffer {
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14)]);
  const sof = Buffer.alloc(19);
  sof.set([0xff, frame, 0x00, 0x11, 8]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

/** Header and logical screen only, without pixel data. */
export function gif(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.write("GIF89a", 0, "ascii");
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  return header;
}

export function webp(kind: "VP8 " | "VP8L" | "VP8X", width: number, height: number): Buffer {
  const payload = Buffer.alloc(16);
  if (kind === "VP8 ") {
    payload.set([0x9d, 0x01, 0x2a], 3);
    payload.writeUInt16LE(width & 0x3fff, 6);
    payload.writeUInt16LE(height & 0x3fff, 8);
  } else if (kind === "VP8L") {
    payload[0] = 0x2f;
    payload.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 1);
  } else {
    payload.writeUIntLE(width - 1, 4, 3);
    payload.writeUIntLE(height - 1, 7, 3);
  }
  const head = Buffer.alloc(20);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(12 + payload.length, 4);
  head.write("WEBP", 8, "ascii");
  head.write(kind, 12, "ascii");
  head.writeUInt32LE(payload.length, 16);
  return Buffer.concat([head, payload]);
}

/** ICO dimensions of 256 are encoded as 0. */
export function ico(width: number, height: number, image: Buffer = Buffer.alloc(40, 1)): Buffer {
  const header = Buffer.from([0, 0, 1, 0, 1, 0]);
  const entry = Buffer.alloc(16);
  entry[0] = width >= 256 ? 0 : width;
  entry[1] = height >= 256 ? 0 : height;
  entry.writeUInt32LE(image.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, image]);
}
