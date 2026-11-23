/**
 * Detect formats from bytes, ignoring Content-Type and filenames. Uploads require PNG; favicons
 * allow several raster formats. Reject SVG because it can contain script.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0) =>
  bytes.length >= at + prefix.length && prefix.every((byte, index) => bytes[at + index] === byte);

const ascii = (text: string) => Array.from({ length: text.length }, (_, at) => text.charCodeAt(at));

/** Read PNG dimensions from the first IHDR chunk; null for invalid bytes. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  // The signature, then the first chunk: length 13, type IHDR, width, height.
  if (!startsWith(bytes, PNG_SIGNATURE) || bytes.length < 33) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || !startsWith(bytes, ascii("IHDR"), 12)) return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export function isPngWithin(bytes: Uint8Array, max: number): boolean {
  const size = pngSize(bytes);
  return (
    size !== null && size.width >= 1 && size.height >= 1 && size.width <= max && size.height <= max
  );
}

export const IMAGE_KINDS = ["png", "ico", "jpg", "webp", "gif"] as const;
export type ImageKind = (typeof IMAGE_KINDS)[number];

export const CONTENT_TYPES: Record<ImageKind, string> = {
  png: "image/png",
  ico: "image/x-icon",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export const MAX_FAVICON_PIXELS = 1024;

type Size = { width: number; height: number };

const viewOf = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** Read the first JPEG frame size (SOF0 to SOF15, excluding DHT, JPG, DAC); null if absent. */
function jpegSize(bytes: Uint8Array): Size | null {
  const view = viewOf(bytes);
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    // Fill bytes before a marker.
    while (at < bytes.length && bytes[at] === 0xff) at += 1;
    const marker = bytes[at] ?? 0;
    at += 1;
    // Markers without a length: TEM, RST0 to RST7.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    // The end of the image, or its data, before any frame.
    if (marker === 0xd9 || marker === 0xda || at + 2 > bytes.length) return null;
    const length = view.getUint16(at);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 7 > bytes.length) return null;
      return { height: view.getUint16(at + 3), width: view.getUint16(at + 5) };
    }
    if (length < 2) return null;
    at += length;
  }
  return null;
}

function gifSize(bytes: Uint8Array): Size | null {
  if (bytes.length < 10) return null;
  const view = viewOf(bytes);
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

/** A WebP's size from its first chunk: VP8 (lossy), VP8L (lossless), or VP8X (extended). */
function webpSize(bytes: Uint8Array): Size | null {
  if (bytes.length < 30) return null;
  const view = viewOf(bytes);
  const payload = 20;
  if (startsWith(bytes, ascii("VP8 "), 12)) {
    // A key frame's start code, then 14-bit width and height.
    if (!startsWith(bytes, [0x9d, 0x01, 0x2a], payload + 3)) return null;
    return {
      width: view.getUint16(payload + 6, true) & 0x3fff,
      height: view.getUint16(payload + 8, true) & 0x3fff,
    };
  }
  if (startsWith(bytes, ascii("VP8L"), 12)) {
    if (bytes[payload] !== 0x2f) return null;
    const bits = view.getUint32(payload + 1, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (startsWith(bytes, ascii("VP8X"), 12)) {
    const u24 = (at: number) =>
      (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16);
    return { width: u24(payload + 4) + 1, height: u24(payload + 7) + 1 };
  }
  return null;
}

/**
 * Check every ICO entry and embedded PNG. Entry size 0 means 256. Reject empty or truncated
 * directories and unreadable PNG dimensions.
 */
function icoSize(bytes: Uint8Array): Size | null {
  const view = viewOf(bytes);
  if (bytes.length < 6) return null;
  const count = view.getUint16(4, true);
  if (count === 0 || bytes.length < 6 + 16 * count) return null;
  let width = 0;
  let height = 0;
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + 16 * index;
    width = Math.max(width, bytes[entry] || 256);
    height = Math.max(height, bytes[entry + 1] || 256);
    const offset = view.getUint32(entry + 12, true);
    if (offset < bytes.length && startsWith(bytes, PNG_SIGNATURE, offset)) {
      const png = pngSize(bytes.subarray(offset));
      if (png === null) return null;
      width = Math.max(width, png.width);
      height = Math.max(height, png.height);
    }
  }
  return { width, height };
}

const within = (size: Size | null) =>
  size !== null &&
  size.width >= 1 &&
  size.height >= 1 &&
  size.width <= MAX_FAVICON_PIXELS &&
  size.height <= MAX_FAVICON_PIXELS;

/**
 * Accept raster favicons only with readable dimensions up to MAX_FAVICON_PIXELS. Small files
 * can declare huge images that freeze the dashboard.
 */
export function faviconKind(bytes: Uint8Array): ImageKind | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return within(pngSize(bytes)) ? "png" : null;
  // ICONDIR: reserved 0, type 1.
  if (startsWith(bytes, [0, 0, 1, 0])) return within(icoSize(bytes)) ? "ico" : null;
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return within(jpegSize(bytes)) ? "jpg" : null;
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) {
    return within(webpSize(bytes)) ? "webp" : null;
  }
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) {
    return within(gifSize(bytes)) ? "gif" : null;
  }
  return null;
}
