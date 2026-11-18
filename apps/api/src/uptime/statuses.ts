/**
 * The status codes a check counts as up: a list of codes and ranges, such
 * as "200-399" (the default) or "200, 204, 300-302". Stored as written
 * here (formatStatuses), with no spaces.
 */
export interface StatusRange {
  from: number;
  to: number;
}

export const DEFAULT_STATUSES = "200-399";

/** At most this many codes and ranges in one list. */
export const MAX_STATUS_PARTS = 10;

/** The ranges a list names, or null when it is not one: codes from 100 to 599, each range low to high. */
export function parseStatuses(text: string): StatusRange[] | null {
  const parts = text.split(",").map((part) => part.trim());
  if (parts.length === 0 || parts.length > MAX_STATUS_PARTS) return null;
  const ranges: StatusRange[] = [];
  for (const part of parts) {
    const match = /^(\d{3})(?:\s*-\s*(\d{3}))?$/.exec(part);
    if (match === null) return null;
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    if (from < 100 || to > 599 || to < from) return null;
    ranges.push({ from, to });
  }
  return ranges;
}

/** "200-399,418": a list as it is stored and shown. */
export function formatStatuses(ranges: readonly StatusRange[]): string {
  return ranges
    .map((range) => (range.from === range.to ? String(range.from) : `${range.from}-${range.to}`))
    .join(",");
}

export function statusMatches(status: number, ranges: readonly StatusRange[]): boolean {
  return ranges.some((range) => status >= range.from && status <= range.to);
}
