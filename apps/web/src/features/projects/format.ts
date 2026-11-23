import { DOCS_URL } from "@/lib/docs";

/** Use this instance's origin for both the tracker and data-host. */
export function installSnippet(
  instanceOrigin: string,
  publicKey: string,
  { heatmaps = false }: { heatmaps?: boolean } = {},
): string {
  return `<script defer src="${instanceOrigin}/t.js" data-key="${publicKey}" data-host="${instanceOrigin}"${heatmaps ? ' data-heatmaps="on"' : ""}></script>`;
}

export const AGENT_DOCS_URL = `${DOCS_URL}/llms.txt`;

export const REPLAY_CONSENT_DOCS_URL = `${DOCS_URL}/session-replay/turning-it-on/#consent`;

/** Copy only the public key. Tell the agent to read the secret key from the environment. */
export function setupPrompt(
  instanceOrigin: string,
  publicKey: string,
  { heatmaps = false }: { heatmaps?: boolean } = {},
): string {
  return `Add Ottertrail to this app. Read the instructions for agents at ${AGENT_DOCS_URL} before you change anything. This project's Ottertrail instance is ${instanceOrigin} and its public key is ${publicKey}. Add the tracker to every page. Name signed-in users, with the signature made on the server. Report the errors the app catches. Upload source maps when the app builds. Send the server's traces, logs and errors over OpenTelemetry. Read the secret key from the OTTERTRAIL_SECRET_KEY environment variable. Never put it in client code or in a commit.${
    heatmaps
      ? ' Heatmaps are on for this project: add data-heatmaps="on" to the tracker\'s script tag. To give clicked elements readable names, add data-ottertrail-name="…" (such as "hero-cta") to the elements worth naming; never put personal data in a name.'
      : ""
  }`;
}

/** Accept newlines or commas and strip pasted URLs to hostnames. The API validates entries. */
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

export function keepText(retentionDays: number | null): string {
  if (retentionDays === null) return "Forever";
  const named: Record<number, string> = {
    180: "6 months",
    365: "1 year",
    730: "2 years",
    1825: "5 years",
  };
  return named[retentionDays] ?? `${retentionDays} days`;
}
