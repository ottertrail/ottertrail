import type { CheckCause } from "@/lib/uptime-api";

/** What each cause of a failure is called. */
export const CAUSE_TEXT: Record<CheckCause, string> = {
  timeout: "Timeout",
  refused: "Connection refused",
  connection: "Connection failed",
  dns: "DNS",
  tls: "TLS",
  status: "Status code",
  word: "Word",
  redirects: "Redirects",
  address: "Address not allowed",
};

/** "Every minute", "Every 5 minutes", "Every hour". */
export function intervalText(seconds: number): string {
  if (seconds === 3600) return "Every hour";
  const minutes = seconds / 60;
  return minutes === 1 ? "Every minute" : `Every ${minutes} minutes`;
}

/**
 * "99.95%": two decimals, cut rather than rounded, so a check that was
 * down at all never reads 100%; "–" before the check existed.
 */
export function formatUptime(share: number | null): string {
  if (share === null) return "–";
  if (share >= 1) return "100%";
  return `${(Math.floor(share * 10_000) / 100).toFixed(2)}%`;
}

/** "120 ms", "1.25 s". */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2).replace(/\.?0+$/, "")} s`;
}

/** "16 Nov 2026, 10:05", in the timezone set in Settings. */
export function formatMoment(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("day")} ${part("month")} ${part("year")}, ${part("hour")}:${part("minute")}`;
}

/** "3 h 5 min", "45 s": how long something lasted. */
export function formatSpan(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`;
}
