/** The longest URL a check or a webhook may have. */
export const MAX_URL = 2048;

/** A refused value: a code and a sentence the dashboard shows as it is. */
export interface Problem {
  error: string;
  message: string;
}

/**
 * The URL an uptime check or a webhook may request, or why not: http or
 * https, a host, no user name or password (they would be stored as plain
 * text), at most MAX_URL characters. The fragment is dropped. Its host's
 * addresses are checked separately (addresses.ts, resolveTarget).
 */
export function outboundUrlOf(
  text: string,
  { label, example }: { label: string; example: string },
): URL | Problem {
  const trimmed = text.trim();
  const url = URL.parse(trimmed);
  if (trimmed === "" || url === null) {
    return { error: "invalid_url", message: `Enter a full URL, such as ${example}.` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: "invalid_url", message: `${label} starts with http:// or https://.` };
  }
  if (url.hostname === "") {
    return { error: "invalid_url", message: "The URL has no host." };
  }
  if (url.username !== "" || url.password !== "") {
    return {
      error: "invalid_url",
      message: `${label} must not contain a user name or password. They would be stored as plain text.`,
    };
  }
  url.hash = "";
  if (url.href.length > MAX_URL) {
    return { error: "invalid_url", message: `${label} has at most ${MAX_URL} characters.` };
  }
  return url;
}
