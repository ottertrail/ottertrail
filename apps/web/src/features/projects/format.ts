import { DOCS_URL } from "@/lib/docs";

/**
 * The script tag a site adds to its pages. The instance's own origin serves
 * the tracker (/t.js) and receives the events (data-host). With the
 * project's heatmaps on, it asks the tracker for clicks and scroll depth.
 */
export function installSnippet(
  instanceOrigin: string,
  publicKey: string,
  { heatmaps = false }: { heatmaps?: boolean } = {},
): string {
  return `<script defer src="${instanceOrigin}/t.js" data-key="${publicKey}" data-host="${instanceOrigin}"${heatmaps ? ' data-heatmaps="on"' : ""}></script>`;
}

/** Where coding agents read how to add Ottertrail to an app. */
export const AGENT_DOCS_URL = `${DOCS_URL}/llms.txt`;

/** Session replay's consent section, for sites that ask visitors before recording. */
export const REPLAY_CONSENT_DOCS_URL = `${DOCS_URL}/session-replay/turning-it-on/#consent`;

/**
 * What "Copy setup prompt" copies, for a coding agent: the instance's
 * address and the project's public key. Never the secret key: the agent is
 * told to read it from the environment.
 */
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

/** How long a project keeps its events, as its settings name the choice: "Forever", "1 year", "90 days". */
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
