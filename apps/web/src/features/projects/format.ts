/**
 * The script tag a site adds to its pages. The instance's own origin serves
 * the tracker (/t.js) and receives the events (data-host).
 */
export function installSnippet(instanceOrigin: string, publicKey: string): string {
  return `<script defer src="${instanceOrigin}/t.js" data-key="${publicKey}" data-host="${instanceOrigin}"></script>`;
}

/**
 * The allowed-sites box as a list: one hostname per line, or separated by
 * commas. A pasted address (https://example.com/pricing) keeps only its
 * hostname. The API checks every entry and says which one is wrong.
 */
export function hostnamesFromText(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(entry) ? URL.parse(entry) : null;
      return url === null ? entry : url.hostname;
    });
}

const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** "just now", "5 minutes ago", "yesterday", … */
export function timeAgo(date: Date, now = new Date()): string {
  const elapsed = now.getTime() - date.getTime();
  if (elapsed < 60_000) {
    return "just now";
  }
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of units) {
    if (elapsed >= size) {
      return format.format(-Math.floor(elapsed / size), unit);
    }
  }
  return "just now";
}
