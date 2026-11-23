const BYTE_HEX = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, "0"));

/** Positions after which the UUID's text form has a hyphen (8-4-4-4-12). */
const HYPHEN_AFTER = new Set([3, 5, 7, 9]);

/**
 * crypto.randomUUID requires HTTPS or localhost. Fall back to getRandomValues
 * with the version 4 and variant bits from RFC 9562, section 5.4.
 */
export function randomId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // Byte 6's high nibble holds the version, 4; byte 8's top two bits the variant, binary 10.
  bytes[6] = 0x40 + ((bytes[6] ?? 0) % 16);
  bytes[8] = 0x80 + ((bytes[8] ?? 0) % 64);
  let text = "";
  bytes.forEach((byte, index) => {
    text += BYTE_HEX[byte] ?? "00";
    if (HYPHEN_AFTER.has(index)) text += "-";
  });
  return text;
}
